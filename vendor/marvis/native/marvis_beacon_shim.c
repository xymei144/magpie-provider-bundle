// marvis_beacon_shim — plain C bridge over Tencent Marvis's beacon_wrapper.dll
//
// Why: the beacon SDK's uskey minting needs the Client singleton, reachable only
// through a non-exported getter whose offset moves on every client update. The
// shim resolves that offset at runtime from the loaded image, so callers (Bun FFI,
// Python ctypes, anything) only need three stable C entry points.
//
// Exports:
//   int  marvis_shim_init(const char *appKey, const char *appVer)
//   int  marvis_shim_uskey(const char *busInfo, char *out, int outLen)
//   int  marvis_shim_qimei(char *out, int outLen)
//   int  marvis_shim_status(char *out, int outLen)
//
// Build (x64):
//   cl /nologo /LD /O2 /W3 marvis_beacon_shim.c /link /OUT:beacon_shim.dll

#include <windows.h>
#include <stdio.h>
#include <string.h>

typedef int (*fn_init)(const char *, const char *);
typedef int (*fn_get_uskey)(void *, const char *, char *, int);
typedef int (*fn_get_qimei)(char *, int);
typedef void *(*fn_ctx_getter)(void);

static HMODULE g_beacon = NULL;
static fn_init p_init = NULL;
static fn_get_uskey p_uskey = NULL;
static fn_get_qimei p_qimei = NULL;
static void *g_ctx = NULL;
static char g_err[512] = "";
static int g_app_ver_used = 0;
static unsigned g_getter_rva = 0;

static void set_err(const char *msg) {
  strncpy(g_err, msg ? msg : "", sizeof(g_err) - 1);
  g_err[sizeof(g_err) - 1] = 0;
}

/* Locate the Client singleton getter: the first `call rel32` inside
   beacon_get_uskey whose target lands in the code section. Version-agnostic. */
static unsigned detect_getter_rva(unsigned char *base, unsigned func_rva) {
  unsigned char *p = (unsigned char *)base;
  IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)p;
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
  IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(p + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;

  unsigned char *text = NULL;
  unsigned text_size = 0;
  IMAGE_SECTION_HEADER *sec = IMAGE_FIRST_SECTION(nt);
  for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; i++, sec++) {
    if (memcmp(sec->Name, ".text", 5) == 0 || memcmp(sec->Name, "CODE", 4) == 0) {
      text = p + sec->VirtualAddress;
      text_size = sec->Misc.VirtualSize > sec->SizeOfRawData ? sec->Misc.VirtualSize : sec->SizeOfRawData;
      break;
    }
  }
  if (!text || !text_size) return 0;

  unsigned char *code = p + func_rva;
  for (unsigned i = 0; i + 5 <= 0x400; i++) {
    if (code[i] != 0xE8) continue;
    int rel;
    memcpy(&rel, code + i + 1, 4);
    long long target = (long long)func_rva + i + 5 + rel;
    if (target <= 0) continue;
    unsigned char *t = p + (unsigned)target;
    if (t >= text && t < text + text_size && (unsigned)target != func_rva) return (unsigned)target;
  }
  return 0;
}

__declspec(dllexport) int marvis_shim_init(const char *appKey, const char *appVer) {
  if (g_ctx && p_uskey) return 0;

  char path[MAX_PATH] = "";
  HMODULE self = NULL;
  if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          (LPCSTR)&marvis_shim_init, &self)) {
    set_err("GetModuleHandleEx failed");
    return -1;
  }
  GetModuleFileNameA(self, path, MAX_PATH);
  char *slash = strrchr(path, '\\');
  if (slash) *(slash + 1) = 0;
  strncat(path, "beacon_wrapper.dll", sizeof(path) - strlen(path) - 1);

  g_beacon = LoadLibraryA(path);
  if (!g_beacon) {
    snprintf(g_err, sizeof(g_err), "LoadLibrary(%s) failed: %lu", path, GetLastError());
    return -2;
  }
  p_init = (fn_init)GetProcAddress(g_beacon, "beacon_init");
  p_uskey = (fn_get_uskey)GetProcAddress(g_beacon, "beacon_get_uskey");
  p_qimei = (fn_get_qimei)GetProcAddress(g_beacon, "beacon_get_qimei");
  if (!p_init || !p_uskey) {
    set_err("beacon exports missing");
    return -3;
  }

  int rc = p_init(appKey, appVer);
  g_app_ver_used = 1;
  if (rc != 0) {
    snprintf(g_err, sizeof(g_err), "beacon_init rc=%d", rc);
    return -4;
  }

  unsigned char *base = (unsigned char *)g_beacon; /* HMODULE == load base for DLLs */
  unsigned func_rva = 0;
  {
    /* beacon_get_uskey RVA from the export table */
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY dd = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    if (dd.VirtualAddress && dd.Size) {
      IMAGE_EXPORT_DIRECTORY *exp = (IMAGE_EXPORT_DIRECTORY *)(base + dd.VirtualAddress);
      DWORD *names = (DWORD *)(base + exp->AddressOfNames);
      WORD *ords = (WORD *)(base + exp->AddressOfNameOrdinals);
      DWORD *funcs = (DWORD *)(base + exp->AddressOfFunctions);
      for (DWORD i = 0; i < exp->NumberOfNames; i++) {
        const char *n = (const char *)(base + names[i]);
        if (strcmp(n, "beacon_get_uskey") == 0) {
          func_rva = funcs[ords[i]];
          break;
        }
      }
    }
  }
  if (!func_rva) {
    set_err("beacon_get_uskey rva not found");
    return -5;
  }

  g_getter_rva = detect_getter_rva(base, func_rva);
  if (!g_getter_rva) {
    set_err("ctx getter not detected");
    return -6;
  }

  fn_ctx_getter getter = (fn_ctx_getter)(base + g_getter_rva);
  g_ctx = getter();
  if (!g_ctx) {
    set_err("ctx is null");
    return -7;
  }
  g_err[0] = 0;
  return 0;
}

__declspec(dllexport) int marvis_shim_uskey(const char *busInfo, char *out, int outLen) {
  if (!g_ctx || !p_uskey) return -1;
  if (!busInfo || !out || outLen <= 0) return -2;
  memset(out, 0, (size_t)outLen);
  int n = p_uskey(g_ctx, busInfo, out, outLen);
  if (n <= 0) return -3;
  if (n > outLen) n = outLen;
  out[outLen - 1] = 0;
  return n;
}

__declspec(dllexport) int marvis_shim_qimei(char *out, int outLen) {
  if (!g_ctx || !p_qimei) return -1;
  if (!out || outLen <= 0) return -2;
  memset(out, 0, (size_t)outLen);
  int n = p_qimei(out, outLen);
  if (n <= 0) return 0;
  if (n > outLen) n = outLen;
  out[outLen - 1] = 0;
  return n;
}

__declspec(dllexport) int marvis_shim_status(char *out, int outLen) {
  if (!out || outLen <= 0) return -1;
  snprintf(out, (size_t)outLen,
           "{\"ok\":%s,\"beacon\":%s,\"ctx\":%s,\"getterRva\":\"0x%X\",\"err\":\"%s\"}",
           (g_ctx && p_uskey) ? "true" : "false", g_beacon ? "true" : "false",
           g_ctx ? "true" : "false", g_getter_rva, g_err);
  return (int)strlen(out);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
  (void)inst;
  (void)reserved;
  if (reason == DLL_PROCESS_DETACH && g_beacon) {
    FreeLibrary(g_beacon);
    g_beacon = NULL;
  }
  return TRUE;
}
