#include "timeline_layout.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  assert(timeline_relationship(3600,7200,8000,false,true)==TimelineRelationFree);
  assert(timeline_relationship(3600,7200,7200,false,true)==TimelineRelationAdjacent);
  assert(timeline_relationship(3600,7200,6000,false,true)==TimelineRelationOverlap);
  assert(timeline_relationship(3600,7200,6000,true,true)==TimelineRelationNone);
  assert(timeline_relationship(3600,7200,6000,false,false)==TimelineRelationNone);
  assert(timeline_relationship(3600,3600,6000,false,true)==TimelineRelationNone);
  assert(timeline_expanded_height(260)>timeline_compact_height(260));
  assert(timeline_sidebar_width(200)==34);
  puts("✓ timeline: free time, adjacency, overlap, day boundaries and card geometry");
}
