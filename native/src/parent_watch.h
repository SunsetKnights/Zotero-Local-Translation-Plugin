// Parent process supervision. The helper must exit when Zotero goes away, and it
// must not be fooled by PID reuse: the parent handle is opened once, its creation
// time is compared with ours, and the same handle is then waited on.
#pragma once

#include <windows.h>
#include <string>

namespace zt {

typedef LONG (NTAPI * NtQueryInformationProcessFn)(HANDLE, ULONG, PVOID, ULONG, PULONG);

struct ParentInfo {
    unsigned long pid = 0;          // pid the plugin launched us with
    unsigned long actualParent = 0; // pid reported by the OS
    bool handleOpen = false;
    bool creationValid = false;
    std::string error;
};

// Reads the real parent pid through NtQueryInformationProcess instead of trusting
// the command line argument.
inline unsigned long query_parent_pid() {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) {
        return 0;
    }
    auto fn = reinterpret_cast<NtQueryInformationProcessFn>(
        reinterpret_cast<void *>(GetProcAddress(ntdll, "NtQueryInformationProcess")));
    if (!fn) {
        return 0;
    }

    struct process_basic_information {
        PVOID Reserved1;
        PVOID PebBaseAddress;
        PVOID Reserved2[2];
        ULONG_PTR UniqueProcessId;
        ULONG_PTR InheritedFromUniqueProcessId;
    } info = {};

    ULONG len = 0;
    if (fn(GetCurrentProcess(), 0, &info, sizeof(info), &len) != 0) {
        return 0;
    }
    return static_cast<unsigned long>(info.InheritedFromUniqueProcessId);
}

inline bool process_times(HANDLE h, FILETIME & creation, FILETIME & exitTime, FILETIME & kernel, FILETIME & user) {
    return GetProcessTimes(h, &creation, &exitTime, &kernel, &user) != 0;
}

// Opens the parent process and validates that it is the process that launched us
// and that it started before us.
inline ParentInfo open_parent(unsigned long expectedPid, HANDLE & outHandle) {
    ParentInfo info;
    info.pid = expectedPid;
    info.actualParent = query_parent_pid();

    outHandle = nullptr;
    if (expectedPid == 0) {
        info.error = "missing --parent-pid";
        return info;
    }
    if (info.actualParent != 0 && info.actualParent != expectedPid) {
        info.error = "parent pid mismatch (actual " + std::to_string(info.actualParent) + ")";
        return info;
    }

    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD) expectedPid);
    if (!h) {
        info.error = "OpenProcess failed: " + std::to_string(GetLastError());
        return info;
    }

    FILETIME parentCreation = {}, parentExit = {}, parentKernel = {}, parentUser = {};
    FILETIME selfCreation = {}, selfExit = {}, selfKernel = {}, selfUser = {};
    if (!process_times(h, parentCreation, parentExit, parentKernel, parentUser)) {
        CloseHandle(h);
        info.error = "GetProcessTimes(parent) failed";
        return info;
    }
    if (!process_times(GetCurrentProcess(), selfCreation, selfExit, selfKernel, selfUser)) {
        CloseHandle(h);
        info.error = "GetProcessTimes(self) failed";
        return info;
    }

    const ULARGE_INTEGER pc = { parentCreation.dwLowDateTime, parentCreation.dwHighDateTime };
    const ULARGE_INTEGER sc = { selfCreation.dwLowDateTime, selfCreation.dwHighDateTime };
    if (pc.QuadPart > sc.QuadPart) {
        CloseHandle(h);
        info.error = "parent process started after helper";
        return info;
    }

    info.creationValid = true;
    info.handleOpen = true;
    outHandle = h;
    return info;
}

} // namespace zt
