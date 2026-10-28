// Generated from Babel v7.29.8 (MIT); see README.md.
var ParamKind = {
  PARAM: 0,
  PARAM_YIELD: 1,
  PARAM_AWAIT: 2,
  PARAM_RETURN: 4,
  PARAM_IN: 8
};
class ProductionParameterHandler {
  stacks = [];
  enter(flags) {
    this.stacks.push(flags);
  }
  exit() {
    this.stacks.pop();
  }
  currentFlags() {
    return this.stacks[this.stacks.length - 1];
  }
  get hasAwait() {
    return (this.currentFlags() & ParamKind.PARAM_AWAIT) > 0;
  }
  get hasYield() {
    return (this.currentFlags() & ParamKind.PARAM_YIELD) > 0;
  }
  get hasReturn() {
    return (this.currentFlags() & ParamKind.PARAM_RETURN) > 0;
  }
  get hasIn() {
    return (this.currentFlags() & ParamKind.PARAM_IN) > 0;
  }
}
function functionFlags(isAsync, isGenerator) {
  return (isAsync ? ParamKind.PARAM_AWAIT : 0) | (isGenerator ? ParamKind.PARAM_YIELD : 0);
}
export {
  ParamKind,
  ProductionParameterHandler as default,
  functionFlags
};
