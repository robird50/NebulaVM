const OPFS_DIRECTORY = "nebulahv";
const OPFS_DISK_DIRECTORY = "disks";

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
