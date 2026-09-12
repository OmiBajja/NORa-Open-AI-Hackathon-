const fs = require("fs");
const path = require("path");
const { isOwnerPhone } = require("../webhook");

const NOTES_DIR = path.join(__dirname, "..", "..", "data", "notes");

const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;
const USE_NOTION = !!NOTION_API_TOKEN;

const NOTION_VERSION = "2025-09-03";
const NOTION_API_URL = "https://api.notion.com/v1";

function assertOwner(userId) {
  if (!isOwnerPhone(userId)) {
    const error = new Error("This personal assistant is restricted to its configured owner.");
    error.code = "UNAUTHORIZED_OWNER";
    throw error;
  }
}


// ============================================================
// LOCAL FILE HELPERS
// ============================================================

function ensureNotesDir() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function createNoteFileName(title) {
  const safeTitle = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${Date.now()}-${safeTitle || "note"}.md`;
}


// ============================================================
// NOTION HELPERS
// ============================================================

async function notionRequest(endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number(process.env.NOTION_TIMEOUT_MS || 15000)
  );

  let response;
  try {
    response = await fetch(`${NOTION_API_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${NOTION_API_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Notion request timed out.");
      timeoutError.code = "ETIMEDOUT";
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Notion API error (${response.status}): ${
        data.message || JSON.stringify(data)
      }`
    );
  }

  return data;
}

function isOwnedNotePage(page) {
  return Boolean(
    page?.parent?.type === "page_id" &&
      page.parent.page_id === NOTION_PARENT_PAGE_ID
  );
}

async function assertOwnedNotePage(pageId) {
  const page = await notionRequest(`/pages/${pageId}`, { method: "GET" });
  if (!isOwnedNotePage(page)) {
    const error = new Error("The requested note is outside the configured notes page.");
    error.code = "NOT_OWNER_RESOURCE";
    throw error;
  }
  return page;
}

function extractPlainText(richText = []) {
  return richText
    .map((item) => item.plain_text || "")
    .join("");
}

function extractBlockText(block) {
  const type = block.type;
  const data = block[type];

  if (!data) return "";

  if (data.rich_text) {
    return extractPlainText(data.rich_text);
  }

  return "";
}


// ============================================================
// NOTION CREATE
// ============================================================

async function createNotionNote(
  { title, content, tags = [] },
  userId
) {
  if (!NOTION_PARENT_PAGE_ID) {
    throw new Error(
      "NOTION_PARENT_PAGE_ID is missing from the environment."
    );
  }

  const children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content,
            },
          },
        ],
      },
    },
  ];

  if (tags.length > 0) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `Tags: ${tags.join(", ")}`,
            },
          },
        ],
      },
    });
  }

  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: `Created by NORA — ${new Date().toISOString()}`,
          },
        },
      ],
    },
  });

  await notionRequest("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        page_id: NOTION_PARENT_PAGE_ID,
      },
      properties: {
        title: {
          title: [
            {
              type: "text",
              text: {
                content: title,
              },
            },
          ],
        },
      },
      children,
    }),
  });

  return `Saved note "${title}" to Notion.`;
}


// ============================================================
// NOTION SEARCH
// ============================================================

async function searchNotionNotes({ query }, userId) {
  const data = await notionRequest("/search", {
    method: "POST",
    body: JSON.stringify({
      query,
      page_size: 20,
      filter: {
        property: "object",
        value: "page",
      },
    }),
  });

  if (!data.results || data.results.length === 0) {
    return "No saved notes matched the search.";
  }

  const results = [];

  for (const page of data.results) {
    try {
      if (!isOwnedNotePage(page)) continue;
      const blocks = await notionRequest(
        `/blocks/${page.id}/children?page_size=100`,
        {
          method: "GET",
        }
      );

      const title =
        page.properties?.title?.title
          ? extractPlainText(page.properties.title.title)
          : "Untitled";

      const content = blocks.results
        .map(extractBlockText)
        .filter(Boolean)
        .join("\n");

      const searchableText =
        `${title}\n${content}`.toLowerCase();

      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      const score = words.reduce(
        (total, word) =>
          total +
          (searchableText.includes(word) ? 1 : 0),
        0
      );

      if (score > 0) {
        results.push({
          pageId: page.id,
          title,
          content,
          score,
        });
      }
    } catch (error) {
      console.error(
        `[Notion] Failed to read page ${page.id}:`,
        error.message
      );
    }
  }

  results.sort((a, b) => b.score - a.score);

  const topResults = results.slice(0, 5);

  if (topResults.length === 0) {
    return "No saved notes matched the search.";
  }

  return topResults
    .map(
      (result) =>
        `--- ${result.title} ---\n` +
        `page_id: ${result.pageId}\n` +
        `${result.content}`
    )
    .join("\n\n---\n\n");
}


// ============================================================
// NOTION UPDATE
// ============================================================

async function updateNotionNote(
  { page_id, title, content, tags = [] },
  userId
) {
  if (!page_id) {
    throw new Error(
      "page_id is required to update a Notion note."
    );
  }

  await assertOwnedNotePage(page_id);

  // ----------------------------------------------------------
  // 1. Update the page title if one was provided
  // ----------------------------------------------------------

  if (title) {
    await notionRequest(`/pages/${page_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          title: {
            title: [
              {
                type: "text",
                text: {
                  content: title,
                },
              },
            ],
          },
        },
      }),
    });
  }

  // ----------------------------------------------------------
  // 2. Get existing blocks
  // ----------------------------------------------------------

  const blocks = await notionRequest(
    `/blocks/${page_id}/children?page_size=100`,
    {
      method: "GET",
    }
  );

  // ----------------------------------------------------------
  // 3. Delete existing blocks
  // ----------------------------------------------------------

  for (const block of blocks.results) {
    try {
      await notionRequest(`/blocks/${block.id}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error(
        `[Notion] Failed to delete block ${block.id}:`,
        error.message
      );
    }
  }

  // ----------------------------------------------------------
  // 4. Rebuild the note content
  // ----------------------------------------------------------

  const children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content,
            },
          },
        ],
      },
    },
  ];

  if (tags.length > 0) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `Tags: ${tags.join(", ")}`,
            },
          },
        ],
      },
    });
  }

  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: `Updated by NORA — ${new Date().toISOString()}`,
          },
        },
      ],
    },
  });

  // ----------------------------------------------------------
  // 5. Add the new content to the existing page
  // ----------------------------------------------------------

  await notionRequest(`/blocks/${page_id}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      children,
    }),
  });

  return `Updated note${title ? ` "${title}"` : ""} in Notion.`;
}


// ============================================================
// LOCAL CREATE
// ============================================================

async function createLocalNote(
  { title, content, tags = [] },
  userId
) {
  ensureNotesDir();

  const id = Date.now().toString();
  const createdAt = new Date().toISOString();
  const fileName = createNoteFileName(title);
  const filePath = path.join(NOTES_DIR, fileName);

  const markdown = `---
id: ${id}
userId: ${userId}
createdAt: ${createdAt}
tags: ${tags.join(", ")}
---

# ${title}

${content}
`;

  fs.writeFileSync(filePath, markdown, "utf-8");

  return `Saved note "${title}".`;
}


// ============================================================
// LOCAL SEARCH
// ============================================================

async function searchLocalNotes({ query }, userId) {
  ensureNotesDir();

  const files = fs
    .readdirSync(NOTES_DIR)
    .filter((file) => file.endsWith(".md"));

  const searchWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const results = [];

  for (const file of files) {
    const filePath = path.join(NOTES_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");

    const userMatch = content.match(
      /^userId:\s*(.+)$/m
    );

    if (
      !userMatch ||
      userMatch[1].trim() !== String(userId)
    ) {
      continue;
    }

    const lowerContent = content.toLowerCase();

    const score = searchWords.reduce(
      (total, word) =>
        total +
        (lowerContent.includes(word) ? 1 : 0),
      0
    );

    if (score > 0) {
      results.push({
        content,
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  const topResults = results.slice(0, 5);

  if (topResults.length === 0) {
    return "No saved notes matched the search.";
  }

  return topResults
    .map((result) => result.content)
    .join("\n\n---\n\n");
}


// ============================================================
// CREATE NOTE TOOL
// ============================================================

const createNoteSchema = {
  name: "create_note",
  description:
    "Create a new note when the user wants to save a new idea, thought, or information.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title for the new note",
      },
      content: {
        type: "string",
        description:
          "The note content, cleaned up and structured",
      },
      tags: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Relevant tags or categories for the note",
      },
    },
    required: ["title", "content"],
  },
};

async function createNote(args, userId) {
  assertOwner(userId);
  if (USE_NOTION) {
    return createNotionNote(args, userId);
  }

  return createLocalNote(args, userId);
}


// ============================================================
// SEARCH NOTES TOOL
// ============================================================

const searchNotesSchema = {
  name: "search_notes",
  description:
    "Search saved notes when the user asks about something that may have been remembered previously.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Keywords or concepts to search for in saved notes",
      },
    },
    required: ["query"],
  },
};

async function searchNotes(args, userId) {
  assertOwner(userId);
  const results = [];

  // Search Notion
  if (USE_NOTION) {
    const notionResults = await searchNotionNotes(
      args,
      userId
    );

    if (
      notionResults &&
      notionResults !==
        "No saved notes matched the search."
    ) {
      results.push(`=== NOTION ===\n${notionResults}`);
    }
  }

  // Search local notes
  const localResults = await searchLocalNotes(
    args,
    userId
  );

  if (
    localResults &&
    localResults !==
      "No saved notes matched the search."
  ) {
    results.push(
      `=== LOCAL NOTES ===\n${localResults}`
    );
  }

  if (results.length === 0) {
    return "No saved notes matched the search.";
  }

  return results.join(
    "\n\n====================\n\n"
  );
}


// ============================================================
// UPDATE NOTE TOOL
// ============================================================

const updateNoteSchema = {
  name: "update_note",
  description:
    "Modify an existing saved note. Use search_notes first to find the correct note and obtain its page_id. Never create a new note when the user explicitly asks to modify an existing note.",
  parameters: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description:
          "The Notion page_id of the existing note to modify",
      },
      title: {
        type: "string",
        description:
          "The new title of the note. Keep the existing title if it should not change.",
      },
      content: {
        type: "string",
        description:
          "The complete updated content of the note",
      },
      tags: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "The complete updated list of tags",
      },
    },
    required: ["page_id", "content"],
  },
};

async function updateNote(args, userId) {
  assertOwner(userId);
  if (!USE_NOTION) {
    return "Updating local notes is not implemented yet. Please use Notion.";
  }

  return updateNotionNote(args, userId);
}


// ============================================================
// EXPORT TOOLS
// ============================================================

module.exports = [
  {
    schema: createNoteSchema,
    execute: createNote,
  },
  {
    schema: searchNotesSchema,
    execute: searchNotes,
  },
  {
    schema: updateNoteSchema,
    execute: updateNote,
  },
];
