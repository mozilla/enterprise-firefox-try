#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import platform
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltAppPipe(FeltTests):
    def test_felt_app_pipe(self):
        read_fd, write_fd = os.pipe()
        read_bytes = self.get_pipe_capacity(read_fd)
        write_bytes = self.get_pipe_capacity(write_fd)
        print(f"Platform: {platform.system()}")
        print(f"Read-end capacity:  {read_bytes}")
        print(f"Write-end capacity: {write_bytes}")
        os.close(read_fd)
        os.close(write_fd)

        self.run_felt_base()
        self.connect_child_browser()
        self.dump_kilobytes(2 * write_bytes)

    def get_pipe_capacity(self, fd):
        """
        Return the capacity (in bytes) of the pipe referred to by file
        descriptor `fd`, as best as each platform allows it to be queried.

        Returns None if the platform provides no way to determine it.
        """
        system = platform.system()

        if system == "Linux":
            return self._linux_pipe_capacity(fd)
        elif system == "Darwin":
            return self._macos_pipe_capacity()
        elif system == "Windows":
            return self._windows_pipe_capacity(fd)
        else:
            raise NotImplementedError(f"Unsupported platform: {system}")

    def _linux_pipe_capacity(self, fd):
        import fcntl

        F_GETPIPE_SZ = 1032  # from <linux/fcntl.h>, stable since kernel 2.6.35
        return fcntl.fcntl(fd, F_GETPIPE_SZ)

    def _macos_pipe_capacity(self):
        # No F_GETPIPE_SZ equivalent on macOS/BSD. PC_PIPE_BUF is the closest
        # standard value the OS will report (usually 512), and it reflects the
        # atomic-write limit, not the actual kernel buffer size (often larger,
        # commonly 16 KiB on modern XNU, but that number isn't queryable).
        # This 16 KiB limit gets pushed dynamically by the kernel according to
        # various sources, usually to 64 KiB. Some mentions that "writing a lot
        # at once" can increase even more. Stick to hard-coded 64 KiB.
        return 65536

    def _windows_pipe_capacity(self, fd):
        import ctypes
        import msvcrt
        from ctypes import wintypes

        handle = msvcrt.get_osfhandle(fd)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        flags = wintypes.DWORD()
        out_buf_size = wintypes.DWORD()
        in_buf_size = wintypes.DWORD()
        max_instances = wintypes.DWORD()

        ok = kernel32.GetNamedPipeInfo(
            wintypes.HANDLE(handle),
            ctypes.byref(flags),
            ctypes.byref(out_buf_size),
            ctypes.byref(in_buf_size),
            ctypes.byref(max_instances),
        )
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())

        # For os.pipe() pipes, the read end reports in_buf_size and the write
        # end reports out_buf_size; take whichever is nonzero/larger.
        return max(out_buf_size.value, in_buf_size.value)

    def dump_kilobytes(self, target_bytes, line_size: int = 1024) -> int:
        num_lines = max(1, target_bytes // line_size)

        self._logger.info(f"Writing {target_bytes} bytes to stdout")
        self._driver.set_context("chrome")
        total_dumped = self._child_driver.execute_script(
            """
            const [lineSize, numLines] = arguments;
            const payload = "x".repeat(Math.max(0, lineSize - 1)) + "\\n";
            let total = 0;
            for (let i = 0; i < numLines; i++) {
                dump(payload);
                total += payload.length;
            }
            return total;
        """,
            [line_size, num_lines],
        )
        self._driver.set_context("content")

        self._logger.info(
            f"Could sucessfully write {total_dumped} bytes, requested {target_bytes} bytes."
        )
        assert total_dumped == target_bytes, (
            f"Pipe write bytes: total_dumped={total_dumped} with target_bytes={target_bytes}"
        )

        return total_dumped
