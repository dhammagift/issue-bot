import { config } from "./config.js";
import { fetchWithRetry } from "./github.js";

// Trello as one more place a draft can go (owner, card IEFB2ps0): the board's lists are offered next to the
// GitHub repos as targets "trello:<listId>"; "Done" creates a card there. Attachments go onto the card itself
// (Trello stores them), so no media-repo commit is needed for a Trello-only draft.
const API = "https://api.trello.com/1";
const TARGET_PREFIX = "trello:";

function auth() {
  return `key=${encodeURIComponent(config.trelloKey)}&token=${encodeURIComponent(config.trelloToken)}`;
}

async function call(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetchWithRetry(`${API}${path}${sep}${auth()}`, { method, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Trello ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const enabled = () => Boolean(config.trelloKey && config.trelloToken && config.trelloBoard);

// Open lists of the board, cached for an hour like the repo list.
const LIST_CACHE_MS = 60 * 60 * 1000;
let listCache = { at: 0, lists: [] };

async function listTrelloLists() {
  if (!enabled()) return [];
  if (listCache.lists.length && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.lists;
  const lists = await call("GET", `/boards/${encodeURIComponent(config.trelloBoard)}/lists?filter=open&fields=name`);
  listCache = { at: Date.now(), lists: lists.map((l) => ({ id: l.id, name: l.name })) };
  return listCache.lists;
}

// The last fetched lists, for keyboards that are built synchronously.
const cachedTrelloLists = () => listCache.lists;

const isTrelloTarget = (target) => target.startsWith(TARGET_PREFIX);
const trelloTarget = (listId) => TARGET_PREFIX + listId;
const listIdOf = (target) => target.slice(TARGET_PREFIX.length);

function listName(target) {
  const list = listCache.lists.find((l) => l.id === listIdOf(target));
  return list ? list.name : "list";
}

async function createCard(target, { name, desc }) {
  const form = new URLSearchParams({ idList: listIdOf(target), name, desc: desc || "", pos: "top" });
  if (config.trelloLabel) form.set("idLabels", config.trelloLabel);
  return call("POST", "/cards", form);
}

async function attachToCard(cardId, buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("name", filename);
  return call("POST", `/cards/${cardId}/attachments`, form);
}

export { enabled as trelloEnabled, listTrelloLists, cachedTrelloLists, isTrelloTarget, trelloTarget, listName, createCard, attachToCard };
