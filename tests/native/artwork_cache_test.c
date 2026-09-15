#include <assert.h>
#include <stdlib.h>
#include "artwork_cache.h"

struct GBitmap { uint32_t resource; };
static int loads, live;
static bool fail;
GBitmap *gbitmap_create_with_resource(uint32_t resource) {
  loads++;
  if (fail) return NULL;
  GBitmap *bitmap = malloc(sizeof(*bitmap));
  assert(bitmap);bitmap->resource=resource;live++;return bitmap;
}
void gbitmap_destroy(GBitmap *bitmap) { assert(bitmap);live--;free(bitmap); }

int main(void) {
  ArtworkCache cache={0};
  for(int frame=0;frame<20;frame++)assert(artwork_cache_get(&cache,1)->resource==1);
  assert(loads==1&&live==1);
  assert(artwork_cache_get(&cache,2)->resource==2);assert(loads==2&&live==1);
  artwork_cache_clear(&cache);artwork_cache_clear(&cache);assert(live==0);
  fail=true;
  for(int frame=0;frame<20;frame++)assert(!artwork_cache_get(&cache,1));
  assert(loads==3&&live==0);
  artwork_cache_clear(&cache);fail=false;
  assert(artwork_cache_get(&cache,1));assert(loads==4&&live==1);
  artwork_cache_clear(&cache);assert(live==0);
  puts("✓ artwork cache: one load per animation, pose change, allocation fallback, cleanup and retry");
}
