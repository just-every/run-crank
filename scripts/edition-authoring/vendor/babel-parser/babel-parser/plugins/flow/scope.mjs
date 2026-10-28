// Generated from Babel v7.29.8 (MIT); see README.md.
import ScopeHandler, { NameType, Scope } from "../../util/scope.mjs";
import { BindingFlag } from "../../util/scopeflags.mjs";
class FlowScope extends Scope {
  declareFunctions = /* @__PURE__ */ new Set();
}
class FlowScopeHandler extends ScopeHandler {
  createScope(flags) {
    return new FlowScope(flags);
  }
  declareName(name, bindingType, loc) {
    const scope = this.currentScope();
    if (bindingType & BindingFlag.FLAG_FLOW_DECLARE_FN) {
      this.checkRedeclarationInScope(scope, name, bindingType, loc);
      this.maybeExportDefined(scope, name);
      scope.declareFunctions.add(name);
      return;
    }
    super.declareName(name, bindingType, loc);
  }
  isRedeclaredInScope(scope, name, bindingType) {
    if (super.isRedeclaredInScope(scope, name, bindingType)) return true;
    if (bindingType & BindingFlag.FLAG_FLOW_DECLARE_FN && !scope.declareFunctions.has(name)) {
      const type = scope.names.get(name);
      return (type & NameType.Function) > 0 || (type & NameType.Lexical) > 0;
    }
    return false;
  }
  checkLocalExport(id) {
    if (!this.scopeStack[0].declareFunctions.has(id.name)) {
      super.checkLocalExport(id);
    }
  }
}
export {
  FlowScopeHandler as default
};
