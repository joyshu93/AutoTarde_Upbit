export interface ParsedMigrationScript {
  bodySql: string;
  requiresForeignKeysOff: boolean;
  hadTransactionEnvelope: boolean;
}

interface SqlDirective {
  start: number;
  end: number;
  value: string;
}

const FOREIGN_KEY_DIRECTIVE = /\bPRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;/giu;
const SQL_TOKEN = /[A-Za-z_][A-Za-z0-9_]*|;/gu;

export function parseMigrationScript(sql: string): Readonly<ParsedMigrationScript> {
  const source = sql.replace(/^\uFEFF/u, "");
  const masked = maskSqlLiteralsAndComments(source);
  const transactions = findTransactionDirectives(masked);
  const foreignKeys = findForeignKeyDirectives(masked);

  if (transactions.length > 0) {
    if (
      transactions.length !== 2 ||
      transactions[0]?.value !== "BEGIN IMMEDIATE" ||
      transactions[1]?.value !== "COMMIT"
    ) {
      throw malformedMigration();
    }

    const begin = transactions[0];
    const commit = transactions[1];
    if (begin === undefined || commit === undefined || begin.end >= commit.start) {
      throw malformedMigration();
    }

    const hasForeignKeyEnvelope = validateForeignKeyEnvelope(
      source,
      foreignKeys,
      begin.start,
      commit.end,
    );
    const bodySql = source.slice(begin.end, commit.start).trim();
    if (bodySql.length === 0) {
      throw malformedMigration();
    }

    return Object.freeze({
      bodySql,
      requiresForeignKeysOff: hasForeignKeyEnvelope,
      hadTransactionEnvelope: true,
    });
  }

  if (foreignKeys.length === 0) {
    return plainMigration(source);
  }

  if (
    foreignKeys.length === 1 &&
    foreignKeys[0]?.value === "ON" &&
    isSqlTrivia(source.slice(0, foreignKeys[0].start))
  ) {
    return plainMigration(source.slice(foreignKeys[0].end));
  }

  if (
    foreignKeys.length === 2 &&
    foreignKeys[0]?.value === "OFF" &&
    foreignKeys[1]?.value === "ON" &&
    isSqlTrivia(source.slice(0, foreignKeys[0].start)) &&
    isSqlTrivia(source.slice(foreignKeys[1].end))
  ) {
    const bodySql = source.slice(foreignKeys[0].end, foreignKeys[1].start).trim();
    if (bodySql.length === 0) {
      throw malformedMigration();
    }
    return Object.freeze({
      bodySql,
      requiresForeignKeysOff: true,
      hadTransactionEnvelope: false,
    });
  }

  throw malformedMigration();
}

function plainMigration(source: string): Readonly<ParsedMigrationScript> {
  const bodySql = source.trim();
  if (bodySql.length === 0) {
    throw malformedMigration();
  }
  return Object.freeze({
    bodySql,
    requiresForeignKeysOff: false,
    hadTransactionEnvelope: false,
  });
}

function validateForeignKeyEnvelope(
  source: string,
  directives: readonly SqlDirective[],
  beginStart: number,
  commitEnd: number,
): boolean {
  if (directives.length === 0) {
    return isSqlTrivia(source.slice(0, beginStart)) && isSqlTrivia(source.slice(commitEnd));
  }
  if (
    directives.length !== 2 ||
    directives[0]?.value !== "OFF" ||
    directives[1]?.value !== "ON"
  ) {
    throw malformedMigration();
  }

  const disable = directives[0];
  const enable = directives[1];
  if (
    disable === undefined ||
    enable === undefined ||
    disable.end > beginStart ||
    enable.start < commitEnd ||
    !isSqlTrivia(source.slice(0, disable.start)) ||
    !isSqlTrivia(source.slice(disable.end, beginStart)) ||
    !isSqlTrivia(source.slice(commitEnd, enable.start)) ||
    !isSqlTrivia(source.slice(enable.end))
  ) {
    throw malformedMigration();
  }
  return true;
}

function findForeignKeyDirectives(maskedSql: string): SqlDirective[] {
  return Array.from(maskedSql.matchAll(FOREIGN_KEY_DIRECTIVE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    value: match[1]!.toUpperCase(),
  }));
}

function findTransactionDirectives(maskedSql: string): SqlDirective[] {
  const directives: SqlDirective[] = [];
  let atStatementStart = true;
  let current: { start: number; words: string[] } | null = null;
  let createPrefix: string[] | null = null;
  let inTrigger = false;
  let triggerBodyStarted = false;
  let triggerCaseDepth = 0;
  let triggerClosing = false;

  for (const match of maskedSql.matchAll(SQL_TOKEN)) {
    const token = match[0];
    if (inTrigger) {
      if (token === ";") {
        if (triggerClosing) {
          inTrigger = false;
          triggerBodyStarted = false;
          triggerCaseDepth = 0;
          triggerClosing = false;
          atStatementStart = true;
        }
        continue;
      }

      const word = token.toUpperCase();
      if (!triggerBodyStarted) {
        if (word === "BEGIN") triggerBodyStarted = true;
        continue;
      }
      if (triggerClosing) throw malformedMigration();
      if (word === "CASE") {
        triggerCaseDepth += 1;
      } else if (word === "END") {
        if (triggerCaseDepth > 0) triggerCaseDepth -= 1;
        else triggerClosing = true;
      }
      continue;
    }

    if (token === ";") {
      if (current !== null) {
        directives.push({
          start: current.start,
          end: match.index + 1,
          value: current.words.join(" "),
        });
      }
      current = null;
      createPrefix = null;
      atStatementStart = true;
      continue;
    }

    const word = token.toUpperCase();
    if (atStatementStart) {
      if (word === "CREATE") createPrefix = [word];
      else if (["BEGIN", "COMMIT", "ROLLBACK", "END", "SAVEPOINT", "RELEASE"].includes(word)) {
        current = { start: match.index, words: [word] };
      }
      atStatementStart = false;
      continue;
    }

    if (createPrefix !== null) {
      if (
        word === "TRIGGER" &&
        (createPrefix.length === 1 ||
          (createPrefix.length === 2 && ["TEMP", "TEMPORARY"].includes(createPrefix[1]!)))
      ) {
        createPrefix = null;
        inTrigger = true;
        continue;
      }
      if (createPrefix.length === 1 && ["TEMP", "TEMPORARY"].includes(word)) {
        createPrefix.push(word);
        continue;
      }
      createPrefix = null;
    }

    if (current !== null) {
      current.words.push(word);
    }
  }

  if (inTrigger) throw malformedMigration();
  if (current !== null) {
    directives.push({ start: current.start, end: maskedSql.length, value: current.words.join(" ") });
  }
  return directives;
}

function isSqlTrivia(sql: string): boolean {
  return stripSqlComments(sql).trim().length === 0;
}

function stripSqlComments(sql: string): string {
  return maskSql(sql, false);
}

function maskSqlLiteralsAndComments(sql: string): string {
  return maskSql(sql, true);
}

function maskSql(sql: string, maskQuotedValues: boolean): string {
  let result = "";
  let index = 0;
  let state: "NORMAL" | "SINGLE" | "DOUBLE" | "BACKTICK" | "BRACKET" | "LINE" | "BLOCK" = "NORMAL";

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (state === "NORMAL") {
      if (character === "-" && next === "-") {
        result += "  ";
        index += 2;
        state = "LINE";
        continue;
      }
      if (character === "/" && next === "*") {
        result += "  ";
        index += 2;
        state = "BLOCK";
        continue;
      }
      if (character === "'") state = "SINGLE";
      else if (character === '"') state = "DOUBLE";
      else if (character === "`") state = "BACKTICK";
      else if (character === "[") state = "BRACKET";
      result += maskQuotedValues && state !== "NORMAL" ? " " : character;
      index += 1;
      continue;
    }

    if (state === "LINE") {
      result += character === "\n" || character === "\r" ? character : " ";
      if (character === "\n") state = "NORMAL";
      index += 1;
      continue;
    }
    if (state === "BLOCK") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 2;
        state = "NORMAL";
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
        index += 1;
      }
      continue;
    }

    const closingCharacter = state === "SINGLE"
      ? "'"
      : state === "DOUBLE"
        ? '"'
        : state === "BACKTICK"
          ? "`"
          : "]";
    result += maskQuotedValues ? (character === "\n" || character === "\r" ? character : " ") : character;
    index += 1;
    if (character !== closingCharacter) continue;
    if (sql[index] === closingCharacter) {
      result += maskQuotedValues ? " " : sql[index];
      index += 1;
    } else {
      state = "NORMAL";
    }
  }

  return result;
}

function malformedMigration(): Error {
  return new Error("Malformed migration transaction structure.");
}
