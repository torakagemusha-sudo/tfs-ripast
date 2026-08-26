/* SPDX-License-Identifier: GPL-2.0
 * Derived from Kamailio misc/fuzz/fuzz_uri.c
 * Upstream revision: 74015a784f
 * Copyright (C) Kamailio project contributors
 */
#include "../config.h"
#include "../parser/parse_uri.c"

int
LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    struct sip_uri parsed;
    const char *label = "sip_uri";
    if(size >= BUF_SIZE) {
        /* oversized input is ignored without scanning indefinitely */
        return 0;
    }
    parse_uri(data, size, &parsed);
    (void)label;
    return 0;
}
