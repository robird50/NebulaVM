#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>

int __real_fcntl(int fd, int command, ...);

int __wrap_fcntl(int fd, int command, ...)
{
    va_list arguments;
    long argument = 0;

    switch (command) {
    case F_GETFD:
    case F_GETFL:
        return __real_fcntl(fd, command);
    default:
        va_start(arguments, command);
        argument = va_arg(arguments, long);
        va_end(arguments);
        break;
    }

    if (command == F_SETFL || command == F_SETFD) {
        /* WasmFS pipes are already nonblocking and do not support these flags. */
        return 0;
    }

    return __real_fcntl(fd, command, argument);
}
