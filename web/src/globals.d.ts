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

// Function tables the scripts call into. Annotating a table with one of
// these types gives its entries' parameters their types.

/** An RTLIB32 builtin (builtins.js): the VM and the 32-bit argument values. */
type Builtin = (vm: import("./vm.js").VM, args: number[]) => any;

/** A statement handler (stmt-impl.js): the script bytes, a DataView over
 * them and the statement's offset. Returns 0 to stop the script. */
type Statement = (vm: import("./vm.js").VM, b: Uint8Array, dv: DataView, p: number) => any;

/** A plugin extern (an .R32 export): the 32-bit argument values the script
 * passed. Strings and objects are passed as resource or handle ids. */
type Extern = (...args: number[]) => any;

/** A plugin's externs by exported name. */
type Externs = Record<string, Extern>;
