/* SPDX-FileCopyrightText: 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Adapted from PebbleOS Timeline layer.c, relbar.c and calendar_layout.c.
 * Changes: public SDK drawing, app-owned cards, no firmware resource or DB APIs.
 * See THIRD_PARTY_NOTICES.md for provenance.
 */
#include "timeline_ui.h"
#include "agent_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static GColor accent(void) {
#if defined(PBL_COLOR)
  return GColorSunsetOrange;
#else
  return GColorBlack;
#endif
}
static void text(GContext *ctx, const char *value, GRect frame, const char *font, GColor color) {
  graphics_context_set_text_color(ctx,color);
  graphics_draw_text(ctx,value,fonts_get_system_font(font),frame,
                     GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
}
static void icon(GContext *ctx, int x, int y, int day) {
  // Calendar glyph drawn with public SDK primitives; no firmware asset IDs.
  graphics_context_set_fill_color(ctx,accent());
  graphics_fill_rect(ctx,GRect(x,y,24,25),2,GCornersAll);
  graphics_context_set_fill_color(ctx,GColorWhite);
  graphics_fill_rect(ctx,GRect(x+2,y+7,20,16),0,GCornerNone);
  graphics_context_set_stroke_color(ctx,accent());
  graphics_context_set_stroke_width(ctx,2);
  graphics_draw_line(ctx,GPoint(x+6,y-2),GPoint(x+6,y+4));
  graphics_draw_line(ctx,GPoint(x+17,y-2),GPoint(x+17,y+4));
  graphics_context_set_stroke_width(ctx,1);
  char label[4]="";if(day>0&&day<=31)snprintf(label,sizeof(label),"%d",day);
  else {
    graphics_context_set_fill_color(ctx,accent());
    for(int row=0;row<2;row++)for(int col=0;col<3;col++)graphics_fill_rect(ctx,GRect(x+5+col*6,y+11+row*6,3,3),0,GCornerNone);
  }
  graphics_context_set_text_color(ctx,GColorBlack);
  graphics_draw_text(ctx,label,fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                    GRect(x+2,y+5,20,19),GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
}
void timeline_ui_sidebar(GContext *ctx, GRect viewport) {
  int w=timeline_sidebar_width(viewport.size.w),x=viewport.origin.x+viewport.size.w-w;
#if defined(PBL_COLOR)
  graphics_context_set_fill_color(ctx,GColorVividCerulean);
#else
  graphics_context_set_fill_color(ctx,GColorBlack);
#endif
  graphics_fill_rect(ctx,GRect(x,viewport.origin.y,w,viewport.size.h),0,GCornerNone);
  // Native future Timeline's left-pointing notch.
#if defined(PBL_ROUND)
  graphics_context_set_fill_color(ctx,GColorWhite);
  for(int i=0;i<10;i++)graphics_fill_rect(ctx,GRect(x+i,viewport.origin.y+viewport.size.h/2-10+i,1,21-i*2),0,GCornerNone);
#else
  for(int i=0;i<10;i++)graphics_fill_rect(ctx,GRect(x-i,viewport.origin.y+16-i,1,i*2+1),0,GCornerNone);
#endif
}
void timeline_ui_day(GContext *ctx, GRect frame, const char *day) {
  char label[40];agent_protocol_copy(label,sizeof(label),day);
  time_t now=time(NULL);struct tm *today=localtime(&now);char date[16]="";
  if(today)strftime(date,sizeof(date),"%Y-%m-%d",today);
  if(!strcmp(day,date))agent_protocol_copy(label,sizeof(label),"Today");
  else if(strlen(day)==10) {
    // Derive weekday from the local date, never parse all-day dates as UTC.
    struct tm tm={0};tm.tm_year=atoi(day)-1900;tm.tm_mon=atoi(day+5)-1;
    tm.tm_mday=atoi(day+8);tm.tm_hour=12;tm.tm_isdst=-1;
    if(mktime(&tm)!=(time_t)-1)strftime(label,sizeof(label),"%a, %b %d",&tm);
  }
  graphics_context_set_fill_color(ctx,GColorBlack);
  graphics_fill_circle(ctx,GPoint(frame.origin.x+12,frame.origin.y+14),4);
  text(ctx,label,GRect(frame.origin.x+30,frame.origin.y,frame.size.w-32,28),
       FONT_KEY_GOTHIC_18_BOLD,GColorBlack);
}
void timeline_ui_card(GContext *ctx,GRect frame,const char *title,const char *meta,bool expanded,bool cached) {
  char day[16]="",when[24]="",location[40]="";
  agent_protocol_meta_get(meta,"day",day,sizeof(day));
  agent_protocol_meta_get(meta,"time",when,sizeof(when));
  agent_protocol_meta_get(meta,"location",location,sizeof(location));
  int x=frame.origin.x,y=frame.origin.y;
  icon(ctx,x+2,y+5,strlen(day)==10?atoi(day+8):1);
  int left=x+33,width=frame.size.w-37;
  text(ctx,when,GRect(left,y-1,width,25),FONT_KEY_GOTHIC_18_BOLD,GColorBlack);
  int title_h=expanded?frame.size.h-58:frame.size.h-28;
  text(ctx,title,GRect(left,y+23,width,title_h),expanded?FONT_KEY_GOTHIC_24_BOLD:FONT_KEY_GOTHIC_18_BOLD,GColorBlack);
  if(expanded)text(ctx,cached?"Cached preview":location,
      GRect(left,y+frame.size.h-30,width,26),FONT_KEY_GOTHIC_18,GColorBlack);
}
void timeline_ui_relationship(GContext *ctx,int x,int y,const char *meta,const char *next_meta) {
  char day[16]="",next_day[16]="";
  agent_protocol_meta_get(meta,"day",day,sizeof(day));
  agent_protocol_meta_get(next_meta,"day",next_day,sizeof(next_day));
  int32_t start=agent_protocol_meta_get_int(meta,"start",0),end=agent_protocol_meta_get_int(meta,"end",0);
  int32_t next=agent_protocol_meta_get_int(next_meta,"start",0);
  TimelineRelation relation=timeline_relationship(start,end,next,
      agent_protocol_meta_get_bool(meta,"all_day",false),day[0]&&!strcmp(day,next_day));
  if(relation==TimelineRelationNone)return;
  graphics_context_set_stroke_color(ctx,accent());
  graphics_context_set_stroke_width(ctx,2);
  if(relation==TimelineRelationFree){
    for(int i=0;i<20;i+=5)graphics_draw_line(ctx,GPoint(x,y+i),GPoint(x,y+i+2));
  }else{
    graphics_draw_line(ctx,GPoint(x,y),GPoint(x,y+20));
    if(relation==TimelineRelationOverlap)graphics_draw_line(ctx,GPoint(x+5,y),GPoint(x+5,y+20));
  }
  graphics_context_set_stroke_width(ctx,1);
}
void timeline_ui_detail_header(GContext *ctx,GRect frame,const char *title) {
  graphics_context_set_fill_color(ctx,accent());
  graphics_fill_rect(ctx,GRect(frame.origin.x,frame.origin.y,frame.size.w,5),0,GCornerNone);
#if defined(PBL_ROUND)
  frame.origin.x+=26;frame.size.w-=52;frame.origin.y+=16;frame.size.h-=16;
#endif
  icon(ctx,frame.origin.x+8,frame.origin.y+16,0);
  text(ctx,title,GRect(frame.origin.x+42,frame.origin.y+8,frame.size.w-50,frame.size.h-10),
       FONT_KEY_GOTHIC_28_BOLD,GColorBlack);
}
