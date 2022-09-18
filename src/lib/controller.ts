import { CodeStorageProvider } from "./storage/code/code-storage-provider";
import { SourcesDB, ReturnedSource } from "./storage/db/source-db-provider";
import {
  SourceVerifier,
  SourceVerifyPayload,
  CompileResult,
} from "./compiler/source-verifier";
import path from "path";
import { writeFile } from "fs/promises";
import tweetnacl from "tweetnacl";
import { VerifyResult } from "./compiler/source-verifier";
import { Address, beginCell } from "ton";
import BN from "bn.js";

export type Base64URL = string;

export class Controller {
  #codeStorageProvider: CodeStorageProvider;
  #sourcesDB: SourcesDB;
  #sourceVerifier: SourceVerifier;
  #keypair: tweetnacl.SignKeyPair;

  constructor(
    codeStorageProvider: CodeStorageProvider,
    sourcesDB: SourcesDB,
    sourceVerifier: SourceVerifier
  ) {
    this.#codeStorageProvider = codeStorageProvider;
    this.#sourcesDB = sourcesDB;
    this.#sourceVerifier = sourceVerifier;
    this.#keypair = tweetnacl.sign.keyPair.fromSecretKey(
      Buffer.from(process.env.PRIVATE_KEY!, "base64")
    );
  }

  async getSource(hash: Base64URL): Promise<ReturnedSource | undefined> {
    // const src = await this.#sourcesDB.get(hash);
    // if (src) {
    //   const sourcesURLs = await Promise.all(
    //     src.sources.map((s) =>
    //       this.#codeStorageProvider.read(s.codeLocationPointer)
    //     )
    //   );
    //   return {
    //     ...src,
    //     sources: src.sources.map((s, i) => ({
    //       url: sourcesURLs[i],
    //       ...s,
    //     })),
    //   };
    // }
    return undefined;
  }

  async addSource(
    verificationPayload: SourceVerifyPayload
  ): Promise<VerifyResult> {
    // const src = await this.#sourcesDB.get(
    //   verificationPayload.knownContractHash
    // );
    // if (src) throw "Already exists";

    const compileResult = await this.#sourceVerifier.verify(
      verificationPayload
    );

    if (
      compileResult.error ||
      compileResult.result !== "similar" ||
      !compileResult.hash
    )
      return {
        compileResult,
      };

    const sourcesToUpload = verificationPayload.sources.map((s) => ({
      path: s.path,
      name: path.basename(s.path),
    }));

    const fileLocators = await this.#codeStorageProvider.write(
      ...sourcesToUpload
    );

    const sourceSpec = {
      compileCommandLine: compileResult.funcCmd,
      compiler: verificationPayload.compiler,
      version: verificationPayload.version,
      hash: compileResult.hash,
      knownContractAddress: verificationPayload.knownContractAddress,
      verificationDate: Date.now(),
      sources: fileLocators.map((f, i) => ({
        codeLocationPointer: f,
        originalFilename: sourcesToUpload[i].name,
        hasIncludeDirectives:
          verificationPayload.sources[i].hasIncludeDirectives,
        includeInCompile: verificationPayload.sources[i].includeInCompile,
        isEntrypoint: verificationPayload.sources[i].isEntrypoint,
        isStdLib: verificationPayload.sources[i].isStdLib,
      })),
    };

    const jsonPayload = JSON.stringify(sourceSpec);

    const ipfsLink = await this.#codeStorageProvider.writeFromContent(
      Buffer.from(jsonPayload)
    );

    // await this.#sourcesDB.add();

    const now = Math.floor(Date.now() / 1000);

    // This is the message that will be forwarded to verifier registry
    const cell = beginCell()
      .storeUint(now, 32)
      .storeAddress(Address.parse(process.env.SOURCES_REGISTRY!))
      .storeRef(
        // BEGIN: message to sources registry
        beginCell()
          .storeUint(0x1, 32)
          .storeUint(0, 64)
          .storeUint(0, 8) // TODO verifier id
          .storeUint(new BN(Buffer.from(compileResult.hash!, "base64")), 256)
          .storeRef(
            // BEGIN: source item content cell
            beginCell()
              // TODO support snakes
              .storeRef(
                beginCell()
                  .storeBuffer(Buffer.from(`ipfs://${ipfsLink}`))
                  .endCell()
              )
              .endCell()
          )
          .endCell()
      )
      .endCell();

    const sig = Buffer.from(
      tweetnacl.sign.detached(cell.hash(), this.#keypair.secretKey)
    );

    return {
      compileResult,
      sig: sig.toString("base64"),
      ipfsLink: ipfsLink[0],
      msgCell: beginCell().storeBuffer(sig).storeRef(cell).endCell().toBoc(),
    };
  }
}
