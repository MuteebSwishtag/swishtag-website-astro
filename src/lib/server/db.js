import "dotenv/config";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";

const globalForMongo = globalThis;
const globalForMysql = globalThis;
const SUBMISSIONS_COLLECTION = process.env.FORM_SUBMISSIONS_COLLECTION || "form_submissions";
const MYSQL_TABLE = process.env.MYSQL_FORM_SUBMISSIONS_TABLE || SUBMISSIONS_COLLECTION;

function getDatabaseDriver() {
  const configured = (process.env.DB_DRIVER || "").trim().toLowerCase();
  if (configured) return configured;
  if (process.env.MYSQL_URL || process.env.MYSQL_HOST) return "mysql";
  return "mongodb";
}

function isMysqlDriver() {
  return getDatabaseDriver() === "mysql";
}

function cleanMysqlIdentifier(value, fallback) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_]+$/.test(text) ? text : fallback;
}

function mysqlTableName() {
  return `\`${cleanMysqlIdentifier(MYSQL_TABLE, "form_submissions")}\``;
}

function maskHostList(hosts) {
  return hosts
    ? hosts.split(",").map(host => host.trim().replace(/^[^.]+/, "***")).join(",")
    : "";
}

function buildMongoUri(uri) {
  const directHosts = process.env.MONGODB_DIRECT_HOSTS;
  const replicaSet = process.env.MONGODB_REPLICA_SET;
  const dbName = process.env.MONGODB_DB || "";

  if (!uri.startsWith("mongodb+srv://") || !directHosts || !replicaSet) {
    return {
      mode: uri.startsWith("mongodb+srv://") ? "srv" : "standard",
      uri,
    };
  }

  const parsedUri = new URL(uri);
  const credentials = parsedUri.username
    ? `${encodeURIComponent(decodeURIComponent(parsedUri.username))}:${encodeURIComponent(decodeURIComponent(parsedUri.password))}@`
    : "";
  const databasePath = dbName ? `/${encodeURIComponent(dbName)}` : "";

  return {
    mode: "direct-hosts",
    uri: `mongodb://${credentials}${directHosts}${databasePath}?ssl=true&authSource=admin&replicaSet=${encodeURIComponent(replicaSet)}&retryWrites=true&w=majority`,
  };
}

export function getDatabaseDebugInfo() {
  if (isMysqlDriver()) {
    return {
      driver: "mysql",
      hasMysqlUrl: Boolean(process.env.MYSQL_URL),
      host: process.env.MYSQL_HOST || "",
      port: Number(process.env.MYSQL_PORT || 3306),
      database: process.env.MYSQL_DATABASE || "",
      table: cleanMysqlIdentifier(MYSQL_TABLE, "form_submissions"),
      hasUser: Boolean(process.env.MYSQL_USER),
      hasPassword: Boolean(process.env.MYSQL_PASSWORD),
      nodeVersion: process.version,
    };
  }

  return {
    driver: "mongodb",
    hasMongoUri: Boolean(process.env.MONGODB_URI),
    mongoUriType: process.env.MONGODB_URI?.startsWith("mongodb+srv://") ? "srv" : "standard-or-missing",
    database: process.env.MONGODB_DB || "",
    collection: SUBMISSIONS_COLLECTION,
    hasDirectHosts: Boolean(process.env.MONGODB_DIRECT_HOSTS),
    directHosts: maskHostList(process.env.MONGODB_DIRECT_HOSTS || ""),
    replicaSet: process.env.MONGODB_REPLICA_SET || "",
    timeoutMs: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 15000),
    nodeVersion: process.version,
  };
}

export const getMongoDebugInfo = getDatabaseDebugInfo;

export function getClientPromise() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("Missing MONGODB_URI environment variable");
  }

  if (!globalForMongo._mongoClientPromise) {
    const resolved = buildMongoUri(uri);

    console.info("[Swishtag Mongo] creating client", {
      mode: resolved.mode,
      ...getDatabaseDebugInfo(),
    });

    const client = new MongoClient(resolved.uri, {
      serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 15000),
    });

    globalForMongo._mongoClientPromise = client.connect().catch(error => {
      delete globalForMongo._mongoClientPromise;
      console.error("[Swishtag Mongo] connection failed", {
        name: error?.name,
        code: error?.code,
        errno: error?.errno,
        syscall: error?.syscall,
        hostname: error?.hostname,
        message: error?.message,
      });
      throw error;
    });
  }

  return globalForMongo._mongoClientPromise;
}

export async function getDb(name = process.env.MONGODB_DB) {
  if (isMysqlDriver()) {
    throw new Error("getDb() is only available for the MongoDB database driver");
  }

  if (!name) {
    throw new Error("Missing MONGODB_DB environment variable");
  }

  const client = await getClientPromise();
  return client.db(name);
}

function getMysqlConfig() {
  if (process.env.MYSQL_URL) {
    return {
      uri: process.env.MYSQL_URL,
    };
  }

  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
}

export function getMysqlPool() {
  if (!globalForMysql._mysqlPool) {
    const config = getMysqlConfig();

    if (!config.uri && (!config.database || !config.user)) {
      throw new Error("Missing MySQL configuration. Set MYSQL_URL or MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER, and MYSQL_PASSWORD.");
    }

    console.info("[Swishtag MySQL] creating pool", getDatabaseDebugInfo());

    globalForMysql._mysqlPool = config.uri
      ? mysql.createPool({
        uri: config.uri,
        waitForConnections: true,
        connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
      })
      : mysql.createPool({
        ...config,
        waitForConnections: true,
        connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
      });
  }

  return globalForMysql._mysqlPool;
}

function toMysqlDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function reviveKnownDates(document) {
  for (const key of [
    "createdAt",
    "emailSentAt",
    "reminderSentAt",
    "reminderStartedAt",
    "reminderCheckedAt",
    "zoomStartedAt",
    "zoomCreatedAt",
    "meetingConfirmationSentAt",
    "meetingAt",
  ]) {
    if (document[key] && !(document[key] instanceof Date)) {
      const date = new Date(document[key]);
      if (!Number.isNaN(date.getTime())) {
        document[key] = date;
      }
    }
  }
  return document;
}

function normalizeMysqlDocument(row) {
  const parsed = typeof row.document_json === "string"
    ? JSON.parse(row.document_json)
    : row.document_json || {};
  const document = reviveKnownDates(parsed);
  document._id = String(row.id);
  return document;
}

function getPathValue(source, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], source);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function compareValues(actual, expected, operator) {
  if (operator === "$exists") {
    return expected ? actual !== undefined : actual === undefined;
  }

  if (operator === "$in") {
    return Array.isArray(expected) && expected.includes(actual);
  }

  const actualComparable = actual instanceof Date ? actual.getTime() : actual;
  const expectedComparable = expected instanceof Date ? expected.getTime() : expected;

  if (operator === "$lt") return actualComparable < expectedComparable;
  if (operator === "$lte") return actualComparable <= expectedComparable;
  if (operator === "$gt") return actualComparable > expectedComparable;
  if (operator === "$gte") return actualComparable >= expectedComparable;

  return false;
}

function matchesField(document, field, expected) {
  const actual = getPathValue(document, field);

  if (isPlainObject(expected)) {
    return Object.entries(expected).every(([operator, value]) => compareValues(actual, value, operator));
  }

  if (expected === null) {
    return actual === null || actual === undefined;
  }

  return actual === expected;
}

function matchesMongoQuery(document, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$and") {
      return Array.isArray(value) && value.every(item => matchesMongoQuery(document, item));
    }

    if (key === "$or") {
      return Array.isArray(value) && value.some(item => matchesMongoQuery(document, item));
    }

    return matchesField(document, key, value);
  });
}

function compareForSort(left, right, sortSpec) {
  for (const [field, direction] of Object.entries(sortSpec || {})) {
    const leftValue = getPathValue(left, field);
    const rightValue = getPathValue(right, field);
    const leftComparable = leftValue instanceof Date ? leftValue.getTime() : leftValue ?? "";
    const rightComparable = rightValue instanceof Date ? rightValue.getTime() : rightValue ?? "";

    if (leftComparable < rightComparable) return direction < 0 ? 1 : -1;
    if (leftComparable > rightComparable) return direction < 0 ? -1 : 1;
  }

  return 0;
}

function applyMongoUpdate(document, update = {}) {
  const next = { ...document };

  for (const [key, value] of Object.entries(update.$set || {})) {
    next[key] = value;
  }

  for (const key of Object.keys(update.$unset || {})) {
    delete next[key];
  }

  return next;
}

function mysqlColumnValues(document) {
  return [
    document.formType || "",
    document.source || "",
    document.title || "",
    document.email || "",
    document.displayName || "",
    document.companyName || "",
    document.page || "",
    document.ipAddress || "",
    document.userAgent || "",
    document.emailStatus || "",
    document.reminderStatus || "",
    document.zoomStatus || "",
    document.meetingConfirmationStatus || "",
    toMysqlDateTime(document.meetingAt || document.meetingAtISO),
    toMysqlDateTime(document.reminderSentAt),
    toMysqlDateTime(document.reminderStartedAt),
    toMysqlDateTime(document.createdAt || document.createdAtISO || new Date()),
    JSON.stringify(document),
  ];
}

async function ensureMysqlSchema() {
  if (globalForMysql._mysqlSchemaReady) return;

  const pool = getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlTableName()} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      form_type VARCHAR(80) NOT NULL DEFAULT '',
      source VARCHAR(80) NOT NULL DEFAULT '',
      title VARCHAR(160) NOT NULL DEFAULT '',
      email VARCHAR(254) NOT NULL DEFAULT '',
      display_name VARCHAR(160) NOT NULL DEFAULT '',
      company_name VARCHAR(160) NOT NULL DEFAULT '',
      page VARCHAR(500) NOT NULL DEFAULT '',
      ip_address VARCHAR(80) NOT NULL DEFAULT '',
      user_agent VARCHAR(500) NOT NULL DEFAULT '',
      email_status VARCHAR(80) NOT NULL DEFAULT '',
      reminder_status VARCHAR(80) NOT NULL DEFAULT '',
      zoom_status VARCHAR(80) NOT NULL DEFAULT '',
      meeting_confirmation_status VARCHAR(80) NOT NULL DEFAULT '',
      meeting_at DATETIME(3) NULL,
      reminder_sent_at DATETIME(3) NULL,
      reminder_started_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      document_json LONGTEXT NOT NULL,
      PRIMARY KEY (id),
      KEY idx_form_created (form_type, created_at),
      KEY idx_reminder (form_type, reminder_status, reminder_sent_at, meeting_at)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  globalForMysql._mysqlSchemaReady = true;
}

class MysqlFindCursor {
  constructor(collection, query) {
    this.collection = collection;
    this.query = query;
    this.sortSpec = {};
    this.limitValue = 0;
  }

  sort(sortSpec) {
    this.sortSpec = sortSpec || {};
    return this;
  }

  limit(limitValue) {
    this.limitValue = Number(limitValue) || 0;
    return this;
  }

  async toArray() {
    return this.collection.findDocuments(this.query, this.sortSpec, this.limitValue);
  }
}

class MysqlSubmissionCollection {
  async insertOne(document) {
    await ensureMysqlSchema();
    const pool = getMysqlPool();
    const [result] = await pool.query(
      `INSERT INTO ${mysqlTableName()} (
        form_type, source, title, email, display_name, company_name, page, ip_address, user_agent,
        email_status, reminder_status, zoom_status, meeting_confirmation_status,
        meeting_at, reminder_sent_at, reminder_started_at, created_at, document_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mysqlColumnValues(document),
    );

    return {
      insertedId: String(result.insertId),
    };
  }

  async updateOne(filter, update) {
    await ensureMysqlSchema();
    const pool = getMysqlPool();
    const id = filter?._id?.toString?.() || String(filter?._id || "");

    if (!id) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        `SELECT * FROM ${mysqlTableName()} WHERE id = ? FOR UPDATE`,
        [id],
      );

      if (!rows.length) {
        await connection.rollback();
        return { matchedCount: 0, modifiedCount: 0 };
      }

      const document = normalizeMysqlDocument(rows[0]);
      if (!matchesMongoQuery(document, filter)) {
        await connection.rollback();
        return { matchedCount: 0, modifiedCount: 0 };
      }

      const next = applyMongoUpdate(document, update);
      next._id = id;

      await connection.query(
        `UPDATE ${mysqlTableName()} SET
          form_type = ?, source = ?, title = ?, email = ?, display_name = ?, company_name = ?,
          page = ?, ip_address = ?, user_agent = ?, email_status = ?, reminder_status = ?,
          zoom_status = ?, meeting_confirmation_status = ?, meeting_at = ?, reminder_sent_at = ?,
          reminder_started_at = ?, created_at = ?, document_json = ?
        WHERE id = ?`,
        [...mysqlColumnValues(next), id],
      );

      await connection.commit();
      return { matchedCount: 1, modifiedCount: 1 };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async countDocuments(query = {}) {
    const documents = await this.findDocuments(query);
    return documents.length;
  }

  find(query = {}) {
    return new MysqlFindCursor(this, query);
  }

  async findDocuments(query = {}, sortSpec = {}, limitValue = 0) {
    await ensureMysqlSchema();
    const pool = getMysqlPool();
    const where = [];
    const params = [];

    if (query.formType && typeof query.formType === "string") {
      where.push("form_type = ?");
      params.push(query.formType);
    }

    const [rows] = await pool.query(
      `SELECT * FROM ${mysqlTableName()}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
      params,
    );

    let documents = rows.map(normalizeMysqlDocument).filter(document => matchesMongoQuery(document, query));

    if (Object.keys(sortSpec || {}).length) {
      documents = documents.sort((left, right) => compareForSort(left, right, sortSpec));
    }

    if (limitValue > 0) {
      documents = documents.slice(0, limitValue);
    }

    return documents;
  }
}

export async function getSubmissionCollection() {
  if (!isMysqlDriver()) {
    const db = await getDb();
    return db.collection(SUBMISSIONS_COLLECTION);
  }

  return new MysqlSubmissionCollection();
}
