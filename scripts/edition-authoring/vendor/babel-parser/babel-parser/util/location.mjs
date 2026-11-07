// Generated from Babel v7.29.8 (MIT); see README.md.
class Position {
  line;
  column;
  index;
  constructor(line, col, index) {
    this.line = line;
    this.column = col;
    this.index = index;
  }
}
class SourceLocation {
  start;
  end;
  filename;
  identifierName;
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
function createPositionWithColumnOffset(position, columnOffset) {
  const {
    line,
    column,
    index
  } = position;
  return new Position(line, column + columnOffset, index + columnOffset);
}
export {
  Position,
  SourceLocation,
  createPositionWithColumnOffset
};
