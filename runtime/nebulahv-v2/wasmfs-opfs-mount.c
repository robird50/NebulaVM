#include <errno.h>
#include <sys/stat.h>

#include <emscripten/wasmfs.h>

/*
 * Link this into the NebulaHV QEMU build with -sWASMFS=1 and -lopfs.js.
 * QEMU can then open /opfs paths through normal POSIX block I/O without
 * copying an entire guest disk into the fixed WebAssembly heap.
 */
void wasmfs_before_preload(void) {
  backend_t opfs = wasmfs_create_opfs_backend();
  if (opfs == NULL) {
    return;
  }

  int result = wasmfs_create_directory("/opfs", 0777, opfs);
  if (result != 0 && errno != EEXIST) {
    return;
  }
}
