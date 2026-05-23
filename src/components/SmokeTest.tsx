import { useRef, useState } from "react";
import { getSyncRoot, getFileUploader, getFileDownloader } from "../lib/drive";
import type { MaybeNode } from "@protontech/drive-sdk";

type Status = { kind: "idle" } | { kind: "running"; msg: string } | { kind: "ok"; msg: string } | { kind: "err"; msg: string };

export function SmokeTest() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastNodeUid, setLastNodeUid] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err: unknown) {
      setStatus({ kind: "err", msg: String(err) });
    }
  };

  const handleUpload = () => {
    run(async () => {
      const file = fileInputRef.current?.files?.[0];
      if (!file) return;

      setStatus({ kind: "running", msg: "Fetching root folder…" });
      const root = await getSyncRoot();
      if (!root || "error" in root) throw new Error("Failed to fetch root folder");

      const rootNode = root as MaybeNode & { uid: string };

      setStatus({ kind: "running", msg: "Preparing upload…" });
      const uploader = await getFileUploader(rootNode.uid, file.name, {
        mediaType: file.type || "application/octet-stream",
        expectedSize: file.size,
        modificationTime: new Date(file.lastModified),
      });

      setStatus({ kind: "running", msg: "Uploading…" });
      const controller = await uploader.uploadFromFile(file, [], (bytes) => {
        setStatus({ kind: "running", msg: `Uploading… ${(bytes / 1024).toFixed(1)} KB` });
      });
      const { nodeUid } = await controller.completion();
      setLastNodeUid(nodeUid);
      setStatus({ kind: "ok", msg: `Uploaded: ${file.name} (nodeUid: ${nodeUid})` });
    });
  };

  const handleDownload = () => {
    run(async () => {
      if (!lastNodeUid) throw new Error("Upload a file first");

      setStatus({ kind: "running", msg: "Downloading…" });
      const downloader = await getFileDownloader(lastNodeUid);

      const chunks: Uint8Array<ArrayBuffer>[] = [];
      const writable = new WritableStream<Uint8Array>({
        write(chunk) { chunks.push(new Uint8Array(chunk)); },
      });

      const controller = downloader.downloadToStream(writable, (bytes) => {
        setStatus({ kind: "running", msg: `Downloading… ${(bytes / 1024).toFixed(1)} KB` });
      });
      await controller.completion();

      const blob = new Blob(chunks);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "smoke-test-download";
      a.click();
      URL.revokeObjectURL(url);

      setStatus({ kind: "ok", msg: `Downloaded ${(blob.size / 1024).toFixed(1)} KB — check content in downloads folder` });
    });
  };

  const statusClass = status.kind === "err" ? "login-error" : status.kind === "ok" ? "hint" : "hint";

  return (
    <div className="events-card">
      <h2>SDK smoke test</h2>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input ref={fileInputRef} type="file" style={{ fontSize: "0.82rem" }} />
          <button
            className="logout-btn"
            onClick={handleUpload}
            disabled={status.kind === "running"}
          >
            Upload
          </button>
        </div>

        <button
          className="logout-btn"
          onClick={handleDownload}
          disabled={status.kind === "running" || !lastNodeUid}
          style={{ alignSelf: "flex-start" }}
        >
          Download last
        </button>

        {status.kind !== "idle" && (
          <p className={statusClass}>{status.msg}</p>
        )}
      </div>
    </div>
  );
}
