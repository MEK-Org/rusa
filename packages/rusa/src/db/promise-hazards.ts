/**
 * The type-checked gate for the two ways an asynchronous write can escape its
 * caller (#1289).
 *
 * Moving writes behind a promise turns each converted call site into one whose
 * ordering depends on the caller awaiting it. Two mistakes then compile
 * cleanly:
 *
 * - an **unawaited** call: `writer.write(...)` as a bare statement, so the
 *   caller continues before the write has committed and its effects have been
 *   delivered, and a rejection goes nowhere;
 * - an **async implementation of a void port**: TypeScript accepts a function
 *   returning a promise wherever one returning `void` is expected, so an
 *   `async` listener or `async` method assigned to a synchronous port compiles,
 *   and the port's caller neither waits for it nor sees it fail.
 *
 * Both need types to find, and Biome infers too little across modules to see
 * most of them, so this asks the TypeScript checker, as `console-budget.ts`
 * asks the parser.
 *
 * Both checks are scoped to this package's own declarations: a call counts
 * when the function it resolves to is declared under one of `srcRoots`, and a
 * void target counts when it is. A promise chained into `.then`/`.catch`, passed to
 * `void`, assigned, returned or awaited is handled by construction, because the
 * statement is then not a bare call of a package function. Callbacks typed by
 * libraries (`forEach`, event emitters) are out of scope.
 */

import { relative, sep } from "node:path";
import ts from "typescript";

export type PromiseHazardKind = "unawaited" | "async-into-void";

export interface PromiseHazard {
  readonly kind: PromiseHazardKind;
  /** Path relative to the root passed in, with `/` separators. */
  readonly file: string;
  readonly line: number;
  /** What was found: the callee, or how the async function reached the port. */
  readonly text: string;
}

/**
 * Every unawaited call of a package promise function and every promise-returning
 * function given to a package void port, across the program's own source files.
 */
export function findPromiseHazards(
  program: ts.Program,
  packageRoot: string,
  srcRoots: readonly string[]
): PromiseHazard[] {
  const checker = program.getTypeChecker();
  const prefixes = srcRoots.map((root) => (root.endsWith(sep) ? root : root + sep));
  const underSrc = (fileName: string) => prefixes.some((prefix) => fileName.startsWith(prefix));
  const hazards = new Map<string, PromiseHazard>();

  const isThenable = (type: ts.Type): boolean =>
    (type.isUnion() ? type.types : [type]).some((part) => {
      const then = checker.getPropertyOfType(part, "then");
      if (!then) return false;
      return (
        checker.getNonNullableType(checker.getTypeOfSymbol(then)).getCallSignatures().length > 0
      );
    });
  const signatures = (type: ts.Type | undefined): readonly ts.Signature[] =>
    type ? checker.getNonNullableType(type).getCallSignatures() : [];
  const returnsVoidOnly = (type: ts.Type | undefined): boolean => {
    const all = signatures(type);
    return (
      all.length > 0 &&
      all.every((sig) => (checker.getReturnTypeOfSignature(sig).flags & ts.TypeFlags.Void) !== 0)
    );
  };
  const returnsThenable = (type: ts.Type | undefined): boolean =>
    signatures(type).some((sig) => isThenable(checker.getReturnTypeOfSignature(sig)));
  const inPackage = (declaration: ts.Node | undefined): boolean =>
    !!declaration && underSrc(declaration.getSourceFile().fileName);
  const voidPortInPackage = (type: ts.Type): boolean =>
    returnsVoidOnly(type) && signatures(type).every((sig) => inPackage(sig.getDeclaration()));

  const record = (kind: PromiseHazardKind, node: ts.Node, text: string): void => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const file = relative(packageRoot, source.fileName).split(sep).join("/");
    hazards.set(`${kind}\0${file}\0${line}\0${text}`, { kind, file, line, text });
  };

  /** A value of `source` type flowing into `target`: each void method it fills. */
  const checkMembers = (source: ts.Type, target: ts.Type, at: ts.Node, how: string): void => {
    const port = checker.getNonNullableType(target);
    if (port.getCallSignatures().length > 0) return;
    for (const member of port.getProperties()) {
      if (!(member.declarations ?? []).some(inPackage)) continue;
      if (!returnsVoidOnly(checker.getTypeOfSymbolAtLocation(member, at))) continue;
      const filled = checker.getPropertyOfType(source, member.getName());
      if (filled && returnsThenable(checker.getTypeOfSymbolAtLocation(filled, at))) {
        record("async-into-void", at, `${how} .${member.getName()}`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      let call: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(call)) call = call.expression;
      if (
        ts.isCallExpression(call) &&
        isThenable(checker.getTypeAtLocation(call)) &&
        inPackage(checker.getResolvedSignature(call)?.getDeclaration())
      ) {
        record("unawaited", node, call.expression.getText());
      }
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const port = checker.getContextualType(node);
      if (port && voidPortInPackage(port) && returnsThenable(checker.getTypeAtLocation(node))) {
        record("async-into-void", node, "function literal");
      }
    } else if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
      const port = checker.getContextualType(node.parent);
      const member =
        port && checker.getPropertyOfType(checker.getNonNullableType(port), node.name.getText());
      if (
        member &&
        (member.declarations ?? []).some(inPackage) &&
        returnsVoidOnly(checker.getTypeOfSymbolAtLocation(member, node)) &&
        returnsThenable(checker.getTypeAtLocation(node))
      ) {
        record("async-into-void", node, `object method .${node.name.getText()}`);
      }
    } else if (ts.isClassLike(node) && node.heritageClauses) {
      const self = checker.getTypeAtLocation(node);
      for (const clause of node.heritageClauses) {
        for (const heritage of clause.types) {
          checkMembers(self, checker.getTypeAtLocation(heritage), heritage, "class member");
        }
      }
    } else if (ts.isExpression(node) && !ts.isObjectLiteralExpression(node)) {
      const port = checker.getContextualType(node);
      if (port && !(port.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        const value = checker.getTypeAtLocation(node);
        if (value !== port && !(value.flags & ts.TypeFlags.Any)) {
          if (voidPortInPackage(port) && returnsThenable(value)) {
            record("async-into-void", node, `reference ${node.getText().slice(0, 60)}`);
          } else checkMembers(value, port, node, "property");
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !underSrc(source.fileName)) continue;
    visit(source);
  }
  return [...hazards.values()];
}

/** A hazard as one line, for a failure message or an exception list. */
export function formatPromiseHazard(hazard: PromiseHazard): string {
  return `${hazard.kind} ${hazard.file}:${hazard.line} ${hazard.text}`;
}
