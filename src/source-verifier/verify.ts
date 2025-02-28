import normalize from "path-normalize";
import { Cell } from "@ton/core";
import type { Config, Options, ILogger, PackageFileFormat } from "tact-1.6.0";

export type VerifyResult =
  | {
      ok: true;
      package: PackageFileFormat;
      files: Record<string, string>;
    }
  | {
      ok: false;
      error:
        | "invalid-package-format"
        | "invalid-compiler"
        | "invalid-compiler-version"
        | "compilation-failed"
        | "verification-failed";
    };

export async function verifyTactNew(version: string) {
  const { Logger, run } = (await import(`tact-${version}`)) as typeof import("tact-1.6.0");
  const { fileFormat } = (await import(
    `tact-${version}/dist/packaging/fileFormat`
  )) as typeof import("tact-1.6.0/dist/packaging/fileFormat");
  const { getCompilerVersion } = (await import(
    `tact-${version}/dist/pipeline/version`
  )) as typeof import("tact-1.6.0/dist/pipeline/version");

  return async function verify(args: {
    pkg: string;
    logger?: ILogger | null | undefined;
  }): Promise<VerifyResult> {
    const logger: ILogger = args.logger ?? new Logger();

    // Loading package
    let unpacked: PackageFileFormat;
    try {
      const data = JSON.parse(args.pkg);
      unpacked = fileFormat.parse(data);
    } catch (_) {
      return { ok: false, error: "invalid-package-format" };
    }

    if (unpacked.sources === undefined) {
      return { ok: false, error: "invalid-package-format" };
    }

    // Check compiler and version
    if (unpacked.compiler.name !== "tact") {
      return { ok: false, error: "invalid-compiler" };
    }
    if (unpacked.compiler.version !== getCompilerVersion()) {
      return { ok: false, error: "invalid-compiler-version" };
    }

    // Create a options
    if (!unpacked.compiler.parameters) {
      return { ok: false, error: "invalid-package-format" };
    }
    const params = JSON.parse(unpacked.compiler.parameters);
    if (typeof params.entrypoint !== "string") {
      return { ok: false, error: "invalid-package-format" };
    }
    const options: Options = params.options || {};
    const entrypoint: string = params.entrypoint;

    // Create config
    const config: Config = {
      projects: [
        {
          name: "verifier",
          path: normalize("./contract/" + entrypoint),
          output: "./output",
          options,
        },
      ],
    };

    // Build
    const files: Record<string, string> = {};
    for (const [name, source] of Object.entries(unpacked.sources)) {
      files["contract/" + name] = source;
    }

    const result = await run({ config, files, logger });
    if (!result.ok) {
      return { ok: false, error: "compilation-failed" };
    }

    // Read output
    const compiledCell = files["output/verifier_" + unpacked.name + ".code.boc"];
    if (!compiledCell) {
      return { ok: false, error: "verification-failed" };
    }

    // Check output
    const a = Cell.fromBase64(compiledCell);
    const b = Cell.fromBase64(unpacked.code);
    if (!a.equals(b)) {
      return { ok: false, error: "verification-failed" };
    }

    // Return
    return { ok: true, package: unpacked, files };
  };
}
