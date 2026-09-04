export function splitSqlStatements(sql) {
  const statements = [];
  let statementStart = 0;
  let state = "code";
  let dollarDelimiter = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "single_quote") {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = "code";
      continue;
    }
    if (state === "double_quote") {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = "code";
      continue;
    }
    if (state === "line_comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block_comment") {
      if (character === "*" && next === "/") { index += 1; state = "code"; }
      continue;
    }
    if (state === "dollar_quote") {
      if (sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length - 1;
        state = "code";
        dollarDelimiter = null;
      }
      continue;
    }

    if (character === "'") { state = "single_quote"; continue; }
    if (character === '"') { state = "double_quote"; continue; }
    if (character === "-" && next === "-") { index += 1; state = "line_comment"; continue; }
    if (character === "/" && next === "*") { index += 1; state = "block_comment"; continue; }
    if (character === "$") {
      const delimiter = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        dollarDelimiter = delimiter;
        index += delimiter.length - 1;
        state = "dollar_quote";
        continue;
      }
    }
    if (character === ";") {
      const statement = sql.slice(statementStart, index + 1).trim();
      if (statement) statements.push(statement);
      statementStart = index + 1;
    }
  }

  if (state !== "code") throw new Error(`Unterminated ${state} in migration SQL`);
  const trailing = sql.slice(statementStart).trim();
  if (trailing) statements.push(trailing);
  return statements;
}
