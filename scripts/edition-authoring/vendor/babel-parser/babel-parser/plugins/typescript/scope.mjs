// Generated from Babel v7.29.8 (MIT); see README.md.
import ScopeHandler, { NameType, Scope } from "../../util/scope.mjs";
import { BindingFlag, ScopeFlag } from "../../util/scopeflags.mjs";
import { Errors } from "../../parse-error.mjs";
class TypeScriptScope extends Scope {
  tsNames = /* @__PURE__ */ new Map();
}
class TypeScriptScopeHandler extends ScopeHandler {
  importsStack = [];
  createScope(flags) {
    this.importsStack.push(/* @__PURE__ */ new Set());
    return new TypeScriptScope(flags);
  }
  enter(flags) {
    if (flags === ScopeFlag.TS_MODULE) {
      this.importsStack.push(/* @__PURE__ */ new Set());
    }
    super.enter(flags);
  }
  exit() {
    const flags = super.exit();
    if (flags === ScopeFlag.TS_MODULE) {
      this.importsStack.pop();
    }
    return flags;
  }
  hasImport(name, allowShadow) {
    const len = this.importsStack.length;
    if (this.importsStack[len - 1].has(name)) {
      return true;
    }
    if (!allowShadow && len > 1) {
      for (let i = 0; i < len - 1; i++) {
        if (this.importsStack[i].has(name)) return true;
      }
    }
    return false;
  }
  declareName(name, bindingType, loc) {
    if (bindingType & BindingFlag.FLAG_TS_IMPORT) {
      if (this.hasImport(name, true)) {
        this.parser.raise(Errors.VarRedeclaration, loc, {
          identifierName: name
        });
      }
      this.importsStack[this.importsStack.length - 1].add(name);
      return;
    }
    const scope = this.currentScope();
    let type = scope.tsNames.get(name) || 0;
    if (bindingType & BindingFlag.FLAG_TS_EXPORT_ONLY) {
      this.maybeExportDefined(scope, name);
      scope.tsNames.set(name, type | 16);
      return;
    }
    super.declareName(name, bindingType, loc);
    if (bindingType & BindingFlag.KIND_TYPE) {
      if (!(bindingType & BindingFlag.KIND_VALUE)) {
        this.checkRedeclarationInScope(scope, name, bindingType, loc);
        this.maybeExportDefined(scope, name);
      }
      type = type | 1;
    }
    if (bindingType & BindingFlag.FLAG_TS_ENUM) {
      type = type | 2;
    }
    if (bindingType & BindingFlag.FLAG_TS_CONST_ENUM) {
      type = type | 4;
    }
    if (bindingType & BindingFlag.FLAG_CLASS) {
      type = type | 8;
    }
    if (type) scope.tsNames.set(name, type);
  }
  isRedeclaredInScope(scope, name, bindingType) {
    const type = scope.tsNames.get(name);
    if ((type & 2) > 0) {
      if (bindingType & BindingFlag.FLAG_TS_ENUM) {
        const isConst = !!(bindingType & BindingFlag.FLAG_TS_CONST_ENUM);
        const wasConst = (type & 4) > 0;
        return isConst !== wasConst;
      }
      return true;
    }
    if (bindingType & BindingFlag.FLAG_CLASS && (type & 8) > 0) {
      if (scope.names.get(name) & NameType.Lexical) {
        return !!(bindingType & BindingFlag.KIND_VALUE);
      } else {
        return false;
      }
    }
    if (bindingType & BindingFlag.KIND_TYPE && (type & 1) > 0) {
      return true;
    }
    return super.isRedeclaredInScope(scope, name, bindingType);
  }
  checkLocalExport(id) {
    const {
      name
    } = id;
    if (this.hasImport(name)) return;
    const len = this.scopeStack.length;
    for (let i = len - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      const type = scope.tsNames.get(name);
      if ((type & 1) > 0 || (type & 16) > 0) {
        return;
      }
    }
    super.checkLocalExport(id);
  }
}
export {
  TypeScriptScopeHandler as default
};
