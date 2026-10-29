// Generated from Babel v7.29.8 (MIT); see README.md.
import { tokenIsIdentifier, tt } from "../tokenizer/types.mjs";
var stdin_default = (superClass) => class V8IntrinsicMixin extends superClass {
  parseV8Intrinsic() {
    if (this.match(tt.modulo)) {
      const v8IntrinsicStartLoc = this.state.startLoc;
      const node = this.startNode();
      this.next();
      if (tokenIsIdentifier(this.state.type)) {
        const name = this.parseIdentifierName();
        const identifier = this.createIdentifier(node, name);
        this.castNodeTo(identifier, "V8IntrinsicIdentifier");
        if (this.match(tt.parenL)) {
          return identifier;
        }
      }
      this.unexpected(v8IntrinsicStartLoc);
    }
  }
  parseExprAtom(refExpressionErrors) {
    return this.parseV8Intrinsic() || super.parseExprAtom(refExpressionErrors);
  }
};
export {
  stdin_default as default
};
