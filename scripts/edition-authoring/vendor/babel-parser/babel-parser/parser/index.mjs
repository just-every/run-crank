// Generated from Babel v7.29.8 (MIT); see README.md.
import { getOptions, OptionFlags } from "../options.mjs";
import StatementParser from "./statement.mjs";
import ScopeHandler from "../util/scope.mjs";
class Parser extends StatementParser {
  constructor(options, input, pluginsMap) {
    const normalizedOptions = getOptions(options);
    super(normalizedOptions, input);
    this.options = normalizedOptions;
    this.initializeScopes();
    this.plugins = pluginsMap;
    this.filename = normalizedOptions.sourceFilename;
    this.startIndex = normalizedOptions.startIndex;
    let optionFlags = 0;
    if (normalizedOptions.allowAwaitOutsideFunction) {
      optionFlags |= OptionFlags.AllowAwaitOutsideFunction;
    }
    if (normalizedOptions.allowReturnOutsideFunction) {
      optionFlags |= OptionFlags.AllowReturnOutsideFunction;
    }
    if (normalizedOptions.allowImportExportEverywhere) {
      optionFlags |= OptionFlags.AllowImportExportEverywhere;
    }
    if (normalizedOptions.allowSuperOutsideMethod) {
      optionFlags |= OptionFlags.AllowSuperOutsideMethod;
    }
    if (normalizedOptions.allowUndeclaredExports) {
      optionFlags |= OptionFlags.AllowUndeclaredExports;
    }
    if (normalizedOptions.allowNewTargetOutsideFunction) {
      optionFlags |= OptionFlags.AllowNewTargetOutsideFunction;
    }
    if (normalizedOptions.allowYieldOutsideFunction) {
      optionFlags |= OptionFlags.AllowYieldOutsideFunction;
    }
    if (normalizedOptions.ranges) {
      optionFlags |= OptionFlags.Ranges;
    }
    if (normalizedOptions.tokens) {
      optionFlags |= OptionFlags.Tokens;
    }
    if (normalizedOptions.createImportExpressions) {
      optionFlags |= OptionFlags.CreateImportExpressions;
    }
    if (normalizedOptions.createParenthesizedExpressions) {
      optionFlags |= OptionFlags.CreateParenthesizedExpressions;
    }
    if (normalizedOptions.errorRecovery) {
      optionFlags |= OptionFlags.ErrorRecovery;
    }
    if (normalizedOptions.attachComment) {
      optionFlags |= OptionFlags.AttachComment;
    }
    if (normalizedOptions.annexB) {
      optionFlags |= OptionFlags.AnnexB;
    }
    this.optionFlags = optionFlags;
  }
  getScopeHandler() {
    return ScopeHandler;
  }
  parse() {
    this.enterInitialScopes();
    const file = this.startNode();
    const program = this.startNode();
    this.nextToken();
    file.errors = null;
    const result = this.parseTopLevel(file, program);
    result.errors = this.state.errors;
    result.comments.length = this.state.commentsLen;
    return result;
  }
}
export {
  Parser as default
};
