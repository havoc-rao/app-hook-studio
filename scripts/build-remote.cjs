const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Paths are anchored to this script, never the invoking shell's working directory.
function buildRemote(target = path.resolve(__dirname, "../assets/remote-hotkeys")) {
  const source = fs.realpathSync(path.resolve(__dirname, "../apps/quickstart/codebuddy-hotkeys-quickstart"));
  const read = (relative) => {
    const filename = fs.realpathSync(path.resolve(source, relative));
    if (!within(source, filename) || !fs.statSync(filename).isFile())
      throw new Error(`Invalid remote asset: ${relative}`);
    return fs.readFileSync(filename);
  };
  const manifestData = read("runtime/manifest.json");
  const manifest = JSON.parse(manifestData.toString("utf8"));
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files))
    throw new Error("Invalid runtime manifest");
  const entries = new Map([
    ["remote_hotkeys.py", read("remote_hotkeys.py")],
    ["hotkeys.py", read("hotkeys.py")],
    ["runtime/manifest.json", manifestData],
  ]);
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!name || path.basename(name) !== name || name === "." || name === "..")
      throw new Error(`Invalid runtime filename: ${name}`);
    const data = read(`runtime/${name}`);
    if (createHash("sha256").update(data).digest("hex") !== digest)
      throw new Error(`Runtime hash mismatch: ${name}`);
    entries.set(`runtime/${name}`, data);
  }
  target = path.resolve(target);
  // Reject destination symlinks as well as source escapes; do not follow workspace aliases.
  const ensureDirectory = (directory) => {
    if (fs.existsSync(directory)) {
      if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory())
        throw new Error(`Invalid output directory: ${directory}`);
    } else {
      ensureDirectory(path.dirname(directory));
      fs.mkdirSync(directory);
    }
  };
  ensureDirectory(target);
  for (const [relative, data] of entries) {
    const destination = path.join(target, relative);
    ensureDirectory(path.dirname(destination));
    if (
      fs.existsSync(destination) &&
      (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isFile())
    )
      throw new Error(`Invalid output file: ${destination}`);
    fs.writeFileSync(destination, data);
  }
  return { target, files: [...entries.keys()] };
}

module.exports = { buildRemote };
if (require.main === module) {
  const result = buildRemote();
  console.log(`Packaged ${result.files.length} remote installer files in ${result.target}`);
}
