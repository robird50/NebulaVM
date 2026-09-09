const OPFS_DIRECTORY = "nebulahv";
const OPFS_DISK_DIRECTORY = "disks";
const DISK_SAMPLE_BYTES = 64 * 1024;

const buffersEqual = (left, right) => {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.every((value, index) => value === rightBytes[index]);
};

const sampledFilesMatch = async (selected, staged) => {
  if (!staged.size || selected.size !== staged.size) return false;
  const tailStart = Math.max(0, selected.size - DISK_SAMPLE_BYTES);
  const [selectedHead, stagedHead, selectedTail, stagedTail] = await Promise.all([
    selected.slice(0, DISK_SAMPLE_BYTES).arrayBuffer(),
    staged.slice(0, DISK_SAMPLE_BYTES).arrayBuffer(),
    selected.slice(tailStart).arrayBuffer(),
    staged.slice(tailStart).arrayBuffer(),
  ]);
  return buffersEqual(selectedHead, stagedHead) && buffersEqual(selectedTail, stagedTail);
};

export const safeNebulaHVDiskName = (name) => {
  const cleaned = String(name || "disk.raw")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "disk.raw";
};

export const stageNebulaHVDiskInOpfs = async (
  file,
  { storage = navigator.storage, onProgress = () => {} } = {},
) => {
  if (!file?.stream || typeof storage?.getDirectory !== "function") {
    throw new Error("Direct OPFS disks are unavailable in this browser.");
  }

  await storage.persist?.().catch(() => false);
  const root = await storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
  const diskDirectory = await appDirectory.getDirectoryHandle(OPFS_DISK_DIRECTORY, { create: true });
  const diskName = safeNebulaHVDiskName(file.name);
  const diskHandle = await diskDirectory.getFileHandle(diskName, { create: true });
  const existingDisk = await diskHandle.getFile();
  if (await sampledFilesMatch(file, existingDisk)) {
    onProgress({ written: file.size, total: file.size, reused: true });
    return {
      name: diskName,
      size: file.size,
      qemuPath: `/opfs/${OPFS_DIRECTORY}/${OPFS_DISK_DIRECTORY}/${diskName}`,
      reused: true,
    };
  }
  const writable = await diskHandle.createWritable({ keepExistingData: false });
  const reader = file.stream().getReader();
  let written = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      onProgress({ written, total: file.size });
    }
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    await diskDirectory.removeEntry(diskName).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    name: diskName,
    size: written,
    qemuPath: `/opfs/${OPFS_DIRECTORY}/${OPFS_DISK_DIRECTORY}/${diskName}`,
  };
};
