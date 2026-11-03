import { createHash } from "node:crypto";
export const sha256 = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
