// Generated from Babel v7.29.8 (MIT); see README.md.
import { isIdentifierStart } from "../../babel-helper-validator-identifier/index.mjs";
import { isIdentifierStart as isIdentifierStart2, isIdentifierChar, isReservedWord, isStrictBindOnlyReservedWord, isStrictBindReservedWord, isStrictReservedWord, isKeyword } from "../../babel-helper-validator-identifier/index.mjs";
const keywordRelationalOperator = /^in(stanceof)?$/;
function isIteratorStart(current, next, next2) {
  return current === 64 && next === 64 && isIdentifierStart(next2);
}
const reservedWordLikeSet = /* @__PURE__ */ new Set(["break", "case", "catch", "continue", "debugger", "default", "do", "else", "finally", "for", "function", "if", "return", "switch", "throw", "try", "var", "const", "while", "with", "new", "this", "super", "class", "extends", "export", "import", "null", "true", "false", "in", "instanceof", "typeof", "void", "delete", "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "eval", "arguments", "enum", "await"]);
function canBeReservedWord(word) {
  return reservedWordLikeSet.has(word);
}
export {
  canBeReservedWord,
  isIdentifierChar,
  isIdentifierStart2 as isIdentifierStart,
  isIteratorStart,
  isKeyword,
  isReservedWord,
  isStrictBindOnlyReservedWord,
  isStrictBindReservedWord,
  isStrictReservedWord,
  keywordRelationalOperator
};
