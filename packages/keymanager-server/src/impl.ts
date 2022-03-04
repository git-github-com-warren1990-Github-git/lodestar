import fs from "node:fs";
import path from "node:path";
import {SecretKey} from "@chainsafe/bls";
import {Keystore} from "@chainsafe/bls-keystore";
import {
  Api,
  DeletionStatus,
  ImportStatus,
  KeystoreStr,
  SlashingProtectionData,
} from "@chainsafe/lodestar-api/keymanager";
import {fromHexString} from "@chainsafe/ssz";
import {Interchange, SignerType, Validator} from "@chainsafe/lodestar-validator";
import {PubkeyHex} from "@chainsafe/lodestar-validator/src/types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {LOCK_FILE_EXT, getLockFile} from "./util/lockfile";

export const KEY_IMPORTED_PREFIX = "key_imported";
export const DERIVATION_PATH = "m/12381/3600/0/0/0";

export class KeymanagerApi implements Api {
  constructor(
    private readonly logger: ILogger,
    private readonly validator: Validator,
    private readonly importKeystoresPath: string
  ) {}

  getKeystorePathInfoForKey = (pubkey: string): {keystoreFilePath: string; lockFilePath: string} => {
    const keystoreFilename = `${KEY_IMPORTED_PREFIX}_${pubkey}.json`;
    const keystoreFilePath = path.join(this.importKeystoresPath, keystoreFilename);
    return {
      keystoreFilePath,
      lockFilePath: `${keystoreFilePath}${LOCK_FILE_EXT}`,
    };
  };

  /**
   * List all validating pubkeys known to and decrypted by this keymanager binary
   *
   * https://github.com/ethereum/keymanager-APIs/blob/0c975dae2ac6053c8245ebdb6a9f27c2f114f407/keymanager-oapi.yaml
   */
  async listKeys(): Promise<{
    data: {
      validatingPubkey: PubkeyHex;
      /** The derivation path (if present in the imported keystore) */
      derivationPath?: string;
      /** The key associated with this pubkey cannot be deleted from the API */
      readonly?: boolean;
    }[];
  }> {
    const pubkeys = this.validator.validatorStore.votingPubkeys();
    return {
      data: pubkeys.map((pubkey) => ({
        validatingPubkey: pubkey,
        derivationPath: DERIVATION_PATH,
        readonly: this.validator.validatorStore.getSigner(pubkey)?.type !== SignerType.Local,
      })),
    };
  }

  /**
   * Import keystores generated by the Eth2.0 deposit CLI tooling. `passwords[i]` must unlock `keystores[i]`.
   *
   * Users SHOULD send slashing_protection data associated with the imported pubkeys. MUST follow the format defined in
   * EIP-3076: Slashing Protection Interchange Format.
   *
   * @param keystores JSON-encoded keystore files generated with the Launchpad
   * @param passwords Passwords to unlock imported keystore files. `passwords[i]` must unlock `keystores[i]`
   * @param slashingProtection Slashing protection data for some of the keys of `keystores`
   * @returns Status result of each `request.keystores` with same length and order of `request.keystores`
   *
   * https://github.com/ethereum/keymanager-APIs/blob/0c975dae2ac6053c8245ebdb6a9f27c2f114f407/keymanager-oapi.yaml
   */
  async importKeystores(
    keystoresStr: KeystoreStr[],
    passwords: string[],
    slashingProtectionStr: SlashingProtectionData
  ): Promise<{
    data: {
      status: ImportStatus;
      message?: string;
    }[];
  }> {
    const interchange = (slashingProtectionStr as unknown) as Interchange;
    await this.validator.validatorStore.importInterchange(interchange);

    const statuses: {status: ImportStatus; message?: string}[] = [];

    for (let i = 0; i < keystoresStr.length; i++) {
      try {
        const keystoreStr = keystoresStr[i];
        const password = passwords[i];
        if (password === undefined) {
          throw Error(`No password for keystores[${i}]`);
        }

        const keystore = Keystore.parse(keystoreStr);

        // Check for duplicates and skip keystore before decrypting
        if (this.validator.validatorStore.hasVotingPubkey(keystore.pubkey)) {
          statuses[i] = {status: ImportStatus.duplicate};
          continue;
        }

        const secretKey = SecretKey.fromBytes(await keystore.decrypt(password));
        const pubKey = secretKey.toPublicKey().toHex();
        this.validator.validatorStore.addSigner({type: SignerType.Local, secretKey});

        const keystorePathInfo = this.getKeystorePathInfoForKey(pubKey);

        // Persist keys for latter restarts
        await fs.promises.writeFile(keystorePathInfo.keystoreFilePath, keystoreStr, {encoding: "utf8"});
        const lockFile = getLockFile();
        lockFile.lockSync(keystorePathInfo.lockFilePath);

        statuses[i] = {status: ImportStatus.imported};
      } catch (e) {
        statuses[i] = {status: ImportStatus.error, message: (e as Error).message};
      }
    }

    return {data: statuses};
  }

  /**
   * DELETE must delete all keys from `request.pubkeys` that are known to the keymanager and exist in its
   * persistent storage. Additionally, DELETE must fetch the slashing protection data for the requested keys from
   * persistent storage, which must be retained (and not deleted) after the response has been sent. Therefore in the
   * case of two identical delete requests being made, both will have access to slashing protection data.
   *
   * In a single atomic sequential operation the keymanager must:
   * 1. Guarantee that key(s) can not produce any more signature; only then
   * 2. Delete key(s) and serialize its associated slashing protection data
   *
   * DELETE should never return a 404 response, even if all pubkeys from request.pubkeys have no extant keystores
   * nor slashing protection data.
   *
   * Slashing protection data must only be returned for keys from `request.pubkeys` for which a
   * `deleted` or `not_active` status is returned.
   *
   * @param pubkeys List of public keys to delete.
   * @returns Deletion status of all keys in `request.pubkeys` in the same order.
   *
   * https://github.com/ethereum/keymanager-APIs/blob/0c975dae2ac6053c8245ebdb6a9f27c2f114f407/keymanager-oapi.yaml
   */
  async deleteKeystores(
    pubkeysHex: string[]
  ): Promise<{
    data: {
      status: DeletionStatus;
      message?: string;
    }[];
    slashingProtection: SlashingProtectionData;
  }> {
    const deletedKey: boolean[] = [];
    const statuses = new Array<{status: DeletionStatus; message?: string}>(pubkeysHex.length);

    for (let i = 0; i < pubkeysHex.length; i++) {
      try {
        const pubkeyHex = pubkeysHex[i];

        // Skip unknown keys or remote signers
        const signer = this.validator.validatorStore.getSigner(pubkeyHex);
        if (!signer || signer?.type === SignerType.Remote) {
          continue;
        }

        // Remove key from live local signer
        deletedKey[i] = signer?.type === SignerType.Local && this.validator.validatorStore.removeSigner(pubkeyHex);

        // Remove key from blockduties
        // Remove from attestation duties
        // Remove from Sync committee duties
        // Remove from indices
        this.validator.removeDutiesForKey(pubkeyHex);
        const keystorePathInfo = this.getKeystorePathInfoForKey(pubkeyHex);
        // Remove key from persistent storage
        for (const keystoreFile of await fs.promises.readdir(this.importKeystoresPath)) {
          if (keystoreFile.indexOf(pubkeyHex) !== -1) {
            await fs.promises.unlink(keystorePathInfo.keystoreFilePath);
            await fs.promises.unlink(keystorePathInfo.lockFilePath);
          }
        }
      } catch (e) {
        statuses[i] = {status: DeletionStatus.error, message: (e as Error).message};
      }
    }

    const pubkeysBytes = pubkeysHex.map((pubkeyHex) => fromHexString(pubkeyHex));

    const interchangeV5 = await this.validator.validatorStore.exportInterchange(pubkeysBytes, {
      version: "5",
    });

    // After exporting slashing protection data in bulk, render the status
    const pubkeysWithSlashingProtectionData = new Set(interchangeV5.data.map((data) => data.pubkey));
    for (let i = 0; i < pubkeysHex.length; i++) {
      if (statuses[i]?.status === DeletionStatus.error) {
        continue;
      }
      const status = deletedKey[i]
        ? DeletionStatus.deleted
        : pubkeysWithSlashingProtectionData.has(pubkeysHex[i])
        ? DeletionStatus.not_active
        : DeletionStatus.not_found;
      statuses[i] = {status};
    }

    return {
      data: statuses,
      slashingProtection: JSON.stringify(interchangeV5),
    };
  }
}
