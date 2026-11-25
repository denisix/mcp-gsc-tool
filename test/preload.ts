// Runs before every test file (bunfig.toml). Points the token cache at a throwaway folder so no test,
// and no server a test spawns (env is inherited), can ever touch the real ~/.mcp-gsc-tool.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.GSC_TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scm-tokens-"));
