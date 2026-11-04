import { parseExpressionAt } from "acorn";
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Parse only the selected factory; never evaluate the target or build a whole-bundle AST. */
export function assertSymbolExport(source: string, moduleId: number, exportName: string): void {
  // Match a complete object key; 5239 must not match the suffix of 175239.
  const matcher = new RegExp(`(?:^|[,{])${moduleId}:`, "g"),
    match = matcher.exec(source);
  if (!match || matcher.exec(source)) throw new Error(`服务导出契约失败：模块 ${moduleId} 不唯一或不存在。`);
  const parsed = object(parseExpressionAt(source, match.index + match[0].length, { ecmaVersion: "latest" }));
  const first = parsed?.type === "SequenceExpression" ? (parsed.expressions as unknown[])[0] : parsed;
  const factory = object(first);
  if (!factory || !["FunctionExpression", "ArrowFunctionExpression"].includes(String(factory.type)))
    throw new Error(`服务模块 ${moduleId} 不是函数。`);
  const params = factory.params as unknown[];
  const exportsName = object(params[1])?.name;
  if (typeof exportsName !== "string") throw new Error(`模块 ${moduleId} 没有导出参数。`);
  let found = false;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = object(value);
    if (!node) return;
    const left = object(node.left),
      right = object(node.right);
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      left?.type === "MemberExpression" &&
      !left.computed &&
      object(left.object)?.name === exportsName &&
      object(left.property)?.name === exportName &&
      right?.type === "CallExpression" &&
      object(right.callee)?.name === "Symbol"
    ) {
      const args = right.arguments as unknown[];
      if (object(args[0])?.value === exportName) found = true;
    }
    for (const entry of Object.values(node)) visit(entry);
  };
  visit(factory.body);
  if (!found) throw new Error(`服务导出契约失败：模块 ${moduleId} 没有定义 ${exportName} Symbol。`);
}
