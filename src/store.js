// Where each shop's books live between sessions. One JSON document per shop, written whole.
// Local runs keep a file per shop under data/; on AWS the same document goes to one DynamoDB item,
// written only if nobody changed it since it was read.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sampleBooks } from "./shop.js";

export function cleanShopId(value) {
  const id = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  return id || "demo";
}

// One writer at a time for each shop inside this process.
function serialiser() {
  const tails = new Map();
  return (key, fn) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    tails.set(key, run.catch(() => {}));
    return run;
  };
}

export class MemoryStore {
  constructor() {
    this.docs = new Map();
    this.serial = serialiser();
  }
  async load(shopId) {
    const doc = this.docs.get(shopId);
    return doc ? structuredClone(doc) : null;
  }
  async save(shopId, books) {
    this.docs.set(shopId, structuredClone(books));
  }
  // Reads the books (making the demo shop on first use, or what init makes), lets fn change them, saves the result.
  update(shopId, fn, init = sampleBooks) {
    return this.serial(shopId, async () => {
      const books = (await this.load(shopId)) ?? init();
      const out = await fn(books);
      if (out?.books && out.books !== books) await this.save(shopId, out.books);
      else if (!(await this.load(shopId))) await this.save(shopId, books);
      return out;
    });
  }
}

export class FileStore extends MemoryStore {
  constructor(dir) {
    super();
    this.dir = dir;
  }
  path(shopId) {
    return join(this.dir, `${cleanShopId(shopId)}.json`);
  }
  async load(shopId) {
    try {
      return JSON.parse(await readFile(this.path(shopId), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }
  async save(shopId, books) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(shopId)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(books));
    await rename(tmp, this.path(shopId));
  }
}

export class DynamoStore extends MemoryStore {
  constructor(table, region) {
    super();
    this.table = table;
    this.region = region;
    this.versions = new Map();
  }
  async client() {
    if (!this._client) {
      const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      this._client = { db: new DynamoDBClient({ region: this.region }), GetItemCommand, PutItemCommand };
    }
    return this._client;
  }
  async load(shopId) {
    const { db, GetItemCommand } = await this.client();
    const out = await db.send(new GetItemCommand({ TableName: this.table, Key: { shop: { S: shopId } }, ConsistentRead: true }));
    if (!out.Item) {
      this.versions.set(shopId, 0);
      return null;
    }
    this.versions.set(shopId, Number(out.Item.version.N));
    return JSON.parse(out.Item.books.S);
  }
  async save(shopId, books) {
    const { db, PutItemCommand } = await this.client();
    const version = this.versions.get(shopId) ?? 0;
    await db.send(
      new PutItemCommand({
        TableName: this.table,
        Item: { shop: { S: shopId }, version: { N: String(version + 1) }, books: { S: JSON.stringify(books) }, updatedAt: { S: new Date().toISOString() } },
        ConditionExpression: version ? "version = :v" : "attribute_not_exists(shop)",
        ExpressionAttributeValues: version ? { ":v": { N: String(version) } } : undefined,
      }),
    );
    this.versions.set(shopId, version + 1);
  }
}

export function storeFromEnv(env = process.env) {
  if (env.IMALI_STORE === "dynamodb") return new DynamoStore(env.IMALI_TABLE || "imali-ai-alexa-books", env.AWS_REGION || "us-east-1");
  if (env.IMALI_STORE === "memory") return new MemoryStore();
  return new FileStore(env.IMALI_DATA_DIR || join(process.cwd(), "data"));
}
