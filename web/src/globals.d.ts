// Browser APIs the engine feature-tests for that TypeScript's DOM library
// does not declare yet (File System Access API), and console handles.

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  /** The running engine, for poking at it from the console (main.js). */
  engine?: import("./engine.js").Engine;
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}
