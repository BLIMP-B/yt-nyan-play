"""CI-only native-window check; never sends messages to an unresponsive window."""
import ctypes
import json
import sys
from ctypes import wintypes

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
user = ctypes.WinDLL("user32", use_last_error=True)


class ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260),
    ]


kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
if snapshot == ctypes.c_void_p(-1).value:
    raise ctypes.WinError(ctypes.get_last_error())
parents = {}
try:
    entry = ProcessEntry()
    entry.dwSize = ctypes.sizeof(entry)
    available = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
    while available:
        parents[entry.th32ProcessID] = entry.th32ParentProcessID
        available = kernel.Process32NextW(snapshot, ctypes.byref(entry))
finally:
    kernel.CloseHandle(snapshot)

owned = {int(sys.argv[1])}
while True:
    descendants = {pid for pid, parent in parents.items() if parent in owned}
    if descendants <= owned:
        break
    owned |= descendants

callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
user.IsWindowVisible.argtypes = [wintypes.HWND]
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
windows = []


@callback_type
def visit(window, unused):
    pid = wintypes.DWORD()
    user.GetWindowThreadProcessId(window, ctypes.byref(pid))
    if pid.value in owned and user.IsWindowVisible(window):
        name = ctypes.create_unicode_buffer(256)
        user.GetClassNameW(window, name, len(name))
        if name.value.startswith("Qt"):
            windows.append({"pid": pid.value, "handle": int(window), "class": name.value, "visible": True})
    return True


if not user.EnumWindows(visit, 0):
    raise ctypes.WinError(ctypes.get_last_error())
print(json.dumps(windows))
