interface RemoteLayoutInput {
  rootPrefix: string;
  vaultId: string;
}

export interface RemoteLayout {
  vaultPrefix: string;
  manifestKey: string;
  lockKey: string;
  metaKey: string;
  fileKey(path: string): string;
}

export function createRemoteLayout(input: RemoteLayoutInput): RemoteLayout {
  const rootPrefix = trimSlashes(input.rootPrefix || "obsync/v1");
  const vaultPrefix = `${rootPrefix}/vaults/${input.vaultId}`;

  return {
    vaultPrefix,
    manifestKey: `${vaultPrefix}/manifest.json`,
    lockKey: `${vaultPrefix}/locks/sync.lock`,
    metaKey: `${vaultPrefix}/meta/vault.json`,
    fileKey(path: string): string {
      return `${vaultPrefix}/files/${trimLeadingSlashes(path)}`;
    },
  };
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/g, "");
}

