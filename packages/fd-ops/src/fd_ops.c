// Descriptor-relative file primitives for rusa's workdir containment (#1013).
//
// Node's fs has no openat/fstatat/linkat/unlinkat, so a lookup relative to a
// held directory descriptor otherwise needs a /proc/self/fd/<fd>/<name> string,
// which macOS does not have. Each call here takes one directory descriptor and
// one path component and never follows a symlink, so a caller walking a path
// component by component stays beneath the directory it started from. The
// returned descriptors are plain integers, usable with Node's fd-based fs calls.
#define NAPI_VERSION 8
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_NOFOLLOW_ANY
#define O_NOFOLLOW_ANY 0
#endif

static const char *errno_code(int err) {
  switch (err) {
  case EACCES: return "EACCES";
  case EAGAIN: return "EAGAIN";
  case EBADF: return "EBADF";
  case EBUSY: return "EBUSY";
  case EEXIST: return "EEXIST";
  case EINTR: return "EINTR";
  case EINVAL: return "EINVAL";
  case EIO: return "EIO";
  case EISDIR: return "EISDIR";
  case ELOOP: return "ELOOP";
  case EMFILE: return "EMFILE";
  case EMLINK: return "EMLINK";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case ENFILE: return "ENFILE";
  case ENOENT: return "ENOENT";
  case ENOSPC: return "ENOSPC";
  case ENOTDIR: return "ENOTDIR";
  case ENXIO: return "ENXIO";
  case EOPNOTSUPP: return "EOPNOTSUPP";
  case EPERM: return "EPERM";
  case EROFS: return "EROFS";
  case ETXTBSY: return "ETXTBSY";
  case EXDEV: return "EXDEV";
  default: return "UNKNOWN";
  }
}

// Throw an Error shaped like Node's own fs errors: "<CODE>: <text>, <syscall>"
// with code, errno (negative, as libuv reports it) and syscall properties.
static void throw_errno(napi_env env, int err, const char *syscall) {
  const char *code = errno_code(err);
  char message[256];
  snprintf(message, sizeof message, "%s: %s, %s", code, strerror(err), syscall);
  napi_value msg, code_value, error, errno_value, syscall_value;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_create_error(env, code_value, msg, &error);
  napi_create_int32(env, -err, &errno_value);
  napi_set_named_property(env, error, "errno", errno_value);
  napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &syscall_value);
  napi_set_named_property(env, error, "syscall", syscall_value);
  napi_throw(env, error);
}

static bool get_int(napi_env env, napi_value value, const char *what, int32_t *out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_int32(env, value, out) != napi_ok) {
    char message[64];
    snprintf(message, sizeof message, "%s must be an integer", what);
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", message);
    return false;
  }
  return true;
}

// Read one path component. It must be non-empty, contain no '/' or NUL, and not
// be "." or "..": a single step down from the directory, never sideways or up.
// The caller frees the result.
static char *get_component(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "name must be a string");
    return NULL;
  }
  char *name = malloc(length + 1);
  if (name == NULL) {
    napi_throw_error(env, "ENOMEM", "out of memory");
    return NULL;
  }
  napi_get_value_string_utf8(env, value, name, length + 1, &length);
  if (length == 0 || strlen(name) != length || strchr(name, '/') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    free(name);
    napi_throw_error(env, "ERR_INVALID_COMPONENT",
                     "name must be a single path component, not empty, '.' or '..'");
    return NULL;
  }
  return name;
}

static void get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  for (size_t i = argc; i < want; i++) napi_get_undefined(env, &argv[i]);
}

// openat(dirfd, name, flags, mode = 0) -> fd. O_NOFOLLOW (and O_NOFOLLOW_ANY
// where the platform has it) and O_CLOEXEC are always added.
static napi_value fd_openat(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  get_args(env, info, 4, argv);
  int32_t dirfd, flags, mode = 0;
  if (!get_int(env, argv[0], "dirfd", &dirfd) || !get_int(env, argv[2], "flags", &flags)) {
    return NULL;
  }
  napi_valuetype mode_type;
  napi_typeof(env, argv[3], &mode_type);
  if (mode_type != napi_undefined && !get_int(env, argv[3], "mode", &mode)) return NULL;
  char *name = get_component(env, argv[1]);
  if (name == NULL) return NULL;
  int fd;
  do {
    fd = openat(dirfd, name, flags | O_NOFOLLOW | O_NOFOLLOW_ANY | O_CLOEXEC, (mode_t)mode);
  } while (fd < 0 && errno == EINTR);
  int err = errno;
  free(name);
  if (fd < 0) {
    throw_errno(env, err, "openat");
    return NULL;
  }
  napi_value result;
  napi_create_int32(env, fd, &result);
  return result;
}

static void set_bigint(napi_env env, napi_value object, const char *key, uint64_t value) {
  napi_value v;
  napi_create_bigint_uint64(env, value, &v);
  napi_set_named_property(env, object, key, v);
}

static void set_number(napi_env env, napi_value object, const char *key, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, object, key, v);
}

// fstatat(dirfd, name) -> { dev, ino, mode, nlink, size } without following a
// final symlink. dev and ino are bigints, to compare with
// fs.fstatSync(fd, { bigint: true }).
static napi_value fd_fstatat(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  get_args(env, info, 2, argv);
  int32_t dirfd;
  if (!get_int(env, argv[0], "dirfd", &dirfd)) return NULL;
  char *name = get_component(env, argv[1]);
  if (name == NULL) return NULL;
  struct stat st;
  int rc = fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW);
  int err = errno;
  free(name);
  if (rc != 0) {
    throw_errno(env, err, "fstatat");
    return NULL;
  }
  napi_value result;
  napi_create_object(env, &result);
  set_bigint(env, result, "dev", (uint64_t)st.st_dev);
  set_bigint(env, result, "ino", (uint64_t)st.st_ino);
  set_number(env, result, "mode", (double)st.st_mode);
  set_number(env, result, "nlink", (double)st.st_nlink);
  set_number(env, result, "size", (double)st.st_size);
  return result;
}

// linkat(olddirfd, oldname, newdirfd, newname). Never follows oldname and
// fails with EEXIST rather than replacing newname, so it publishes without
// overwriting.
static napi_value fd_linkat(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  get_args(env, info, 4, argv);
  int32_t olddirfd, newdirfd;
  if (!get_int(env, argv[0], "olddirfd", &olddirfd) ||
      !get_int(env, argv[2], "newdirfd", &newdirfd)) {
    return NULL;
  }
  char *oldname = get_component(env, argv[1]);
  if (oldname == NULL) return NULL;
  char *newname = get_component(env, argv[3]);
  if (newname == NULL) {
    free(oldname);
    return NULL;
  }
  int rc = linkat(olddirfd, oldname, newdirfd, newname, 0);
  int err = errno;
  free(oldname);
  free(newname);
  if (rc != 0) {
    throw_errno(env, err, "linkat");
    return NULL;
  }
  return NULL;
}

// unlinkat(dirfd, name). Removes a non-directory entry; a symlink is removed
// itself, never its target.
static napi_value fd_unlinkat(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  get_args(env, info, 2, argv);
  int32_t dirfd;
  if (!get_int(env, argv[0], "dirfd", &dirfd)) return NULL;
  char *name = get_component(env, argv[1]);
  if (name == NULL) return NULL;
  int rc = unlinkat(dirfd, name, 0);
  int err = errno;
  free(name);
  if (rc != 0) {
    throw_errno(env, err, "unlinkat");
    return NULL;
  }
  return NULL;
}

static void export_function(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

NAPI_MODULE_INIT() {
  export_function(env, exports, "openat", fd_openat);
  export_function(env, exports, "fstatat", fd_fstatat);
  export_function(env, exports, "linkat", fd_linkat);
  export_function(env, exports, "unlinkat", fd_unlinkat);
  napi_value nofollow_any;
  napi_create_int32(env, O_NOFOLLOW_ANY, &nofollow_any);
  napi_set_named_property(env, exports, "O_NOFOLLOW_ANY", nofollow_any);
  return exports;
}
