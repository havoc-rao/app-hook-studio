import { listPendingApprovals, respondToApproval } from "../src/apps/codebuddy-cn/approval-client";

async function main() {
  const [action = "list", requestId, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    (action === "list" && requestId) ||
    (action !== "list" && (!["allow", "reject", "skip"].includes(action) || !requestId))
  )
    throw new Error("Usage: npm run approval -- list | <allow|reject|skip> <request_id>");
  const result =
    action === "list"
      ? await listPendingApprovals()
      : await respondToApproval(requestId, action as "allow" | "reject" | "skip");
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
