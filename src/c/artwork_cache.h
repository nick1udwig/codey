#pragma once
#include <pebble.h>

// One transient pose per animation. Remember a failed allocation so subsequent
// frames use the row renderer without repeatedly attempting a large allocation.
typedef struct { GBitmap *bitmap; uint32_t resource; } ArtworkCache;

static inline void artwork_cache_clear(ArtworkCache *cache) {
  if (cache->bitmap) gbitmap_destroy(cache->bitmap);
  cache->bitmap = NULL;
  cache->resource = 0;
}

static inline GBitmap *artwork_cache_get(ArtworkCache *cache, uint32_t resource) {
  if (cache->resource != resource) {
    artwork_cache_clear(cache);
    cache->resource = resource;
    cache->bitmap = gbitmap_create_with_resource(resource);
  }
  return cache->bitmap;
}
