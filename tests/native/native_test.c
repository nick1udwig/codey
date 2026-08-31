#include "agent_protocol.h"
#include "capabilities/internal.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

static int s_failures;

#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition); \
    s_failures += 1; \
  } \
} while (0)

static void test_metadata(void) {
  char value[64];
  char tiny[5];
  const char *meta = "count=42 enabled=yes title=\"Tea \\\"timer\\\"\" "
                     "body='line\\nnext' negative=-17 disabled=no";

  CHECK(agent_protocol_meta_get(meta, "title", value, sizeof(value)));
  CHECK(strcmp(value, "Tea \"timer\"") == 0);
  CHECK(agent_protocol_meta_get(meta, "body", value, sizeof(value)));
  CHECK(strcmp(value, "line\nnext") == 0);
  CHECK(!agent_protocol_meta_get(meta, "missing", value, sizeof(value)));
  CHECK(strcmp(value, "") == 0);
  CHECK(agent_protocol_meta_get(meta, "title", tiny, sizeof(tiny)));
  CHECK(strcmp(tiny, "Tea ") == 0);
  CHECK(agent_protocol_meta_get_int(meta, "count", -1) == 42);
  CHECK(agent_protocol_meta_get_int(meta, "negative", 0) == -17);
  CHECK(agent_protocol_meta_get_int("n=+2147483647", "n", 7) == INT32_MAX);
  CHECK(agent_protocol_meta_get_int("n=-2147483648", "n", 7) == INT32_MIN);
  CHECK(agent_protocol_meta_get_int("n=2147483648", "n", 7) == 7);
  CHECK(agent_protocol_meta_get_int("n=-2147483649", "n", 7) == 7);
  CHECK(agent_protocol_meta_get_int("n=12x", "n", 7) == 7);
  CHECK(agent_protocol_meta_get_bool(meta, "enabled", false));
  CHECK(!agent_protocol_meta_get_bool(meta, "disabled", true));
  CHECK(agent_protocol_meta_get_bool("flag=maybe", "flag", true));
}

static void test_copy(void) {
  char destination[5] = "xxxx";
  agent_protocol_copy(destination, sizeof(destination), "abcdef");
  CHECK(strcmp(destination, "abcd") == 0);
  agent_protocol_copy(destination, sizeof(destination), NULL);
  CHECK(strcmp(destination, "") == 0);
  agent_protocol_copy(NULL, 0, "safe");
}

static void test_durations(void) {
  char value[24];
  CHECK(agent_capability_parse_duration("5", -1) == 5);
  CHECK(agent_capability_parse_duration("5s", -1) == 5);
  CHECK(agent_capability_parse_duration("2m", -1) == 120);
  CHECK(agent_capability_parse_duration("3h", -1) == 10800);
  CHECK(agent_capability_parse_duration("2d", -1) == 172800);
  CHECK(agent_capability_parse_duration("-1m", 9) == 9);
  CHECK(agent_capability_parse_duration("1w", 9) == 9);
  CHECK(agent_capability_parse_duration("999999999d", 9) == 9);
  CHECK(agent_capability_parse_duration("", 9) == 9);

  agent_capability_format_duration(value, sizeof(value), 0, false);
  CHECK(strcmp(value, "00:00") == 0);
  agent_capability_format_duration(value, sizeof(value), 125, false);
  CHECK(strcmp(value, "02:05") == 0);
  agent_capability_format_duration(value, sizeof(value), 3661, false);
  CHECK(strcmp(value, "1:01:01") == 0);
  agent_capability_format_duration(value, sizeof(value), 5, true);
  CHECK(strcmp(value, "0:00:05") == 0);
  agent_capability_format_duration(value, sizeof(value), -5, false);
  CHECK(strcmp(value, "00:00") == 0);
}

int main(void) {
  test_metadata();
  test_copy();
  test_durations();
  if (s_failures) {
    fprintf(stderr, "%d native test(s) failed\n", s_failures);
    return 1;
  }
  puts("✓ native metadata, bounds, duration parsing, and formatting");
  return 0;
}
