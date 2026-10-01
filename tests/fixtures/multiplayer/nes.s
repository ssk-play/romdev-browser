; MP ABI bootstrap and native NES Four Score fixture, derived from romdev M1 (MIT). Only $4016/$4017 provide game input.
; $0300-$0303: pads, $0304-$0305: signatures, $0308-$030B: positions.
; $030C: completed game tick; four independently moving colored sprites.
.segment "HEADER"
.byte $4e,$45,$53,$1a,2,1,1,0,0,0,0,0,0,0,0,0
.segment "CODE"
reset:
 sei
 cld
 ldx #$ff
 txs
 lda #0
 sta $2000
 sta $2001
 sta $4010
 sta $4015
 sta $4017
 bit $2002
@v1: bit $2002
 bpl @v1
@v2: bit $2002
 bpl @v2
 lda #0
 ldx #0
@clear:
 sta $0000,x
 sta $0100,x
 sta $0300,x
 sta $0400,x
 sta $0500,x
 sta $0600,x
 sta $0700,x
 lda #$ff
 sta $0200,x
 lda #0
 inx
 bne @clear
 lda #$20
 sta $2006
 lda #0
 sta $2006
 ldx #4
 ldy #0
@nt: sta $2007
 iny
 bne @nt
 dex
 bne @nt
 lda #$3f
 sta $2006
 lda #0
 sta $2006
 ldx #0
@pal: lda palette,x
 sta $2007
 inx
 cpx #32
 bne @pal
 ; MP ABI 1: publish before the world; the runtime configuration releases the wait.
 lda #$4d
 sta $03f0
 lda #$50
 sta $03f1
 lda #1
 sta $03f2
 sta $03f7
 lda #8
 sta $03f3
 lda #0
 sta $03f4
 lda #4
 sta $03f5
 lda #32
 sta $03f6
@bootstrap:
 lda $0407
 beq @bootstrap
 lda $040c
 sta $0311
 lda #$a5
 sta $0312
 ldx #0
@pos:
 lda positions,x
 sta $0308,x
 inx
 cpx #4
 bne @pos
 lda #$80
 sta $2000
 lda #$1e
 sta $2001
@tick:
 lda $00
@wait: cmp $00
 beq @wait
 lda #1
 sta $4016
 lda #0
 sta $4016
 sta $0300
 sta $0301
 sta $0302
 sta $0303
 sta $0304
 sta $0305
 ldx #8
@pads12:
 lda $4016
 lsr
 ror $0300
 lda $4017
 lsr
 ror $0301
 dex
 bne @pads12
 ldx #8
@pads34:
 lda $4016
 lsr
 ror $0302
 lda $4017
 lsr
 ror $0303
 dex
 bne @pads34
 ldx #8
@sig:
 lda $4016
 lsr
 ror $0304
 lda $4017
 lsr
 ror $0305
 dex
 bne @sig
 lda $0404
 and #1
 beq @absent0
 lda $0300+0
 tax
 lda canonical,x
 jmp @put0
@absent0: lda #0
 sta $0300+0
@put0: sta $0410+0
 lda $0404
 and #2
 beq @absent1
 lda $0300+1
 tax
 lda canonical,x
 jmp @put1
@absent1: lda #0
 sta $0300+1
@put1: sta $0410+1
 lda $0404
 and #4
 beq @absent2
 lda $0300+2
 tax
 lda canonical,x
 jmp @put2
@absent2: lda #0
 sta $0300+2
@put2: sta $0410+2
 lda $0404
 and #8
 beq @absent3
 lda $0300+3
 tax
 lda canonical,x
 jmp @put3
@absent3: lda #0
 sta $0300+3
@put3: sta $0410+3
 ldx #0
@move:
 lda $0300,x
 and #$80
 beq @left
 inc $0308,x
@left:
 lda $0300,x
 and #$40
 beq @sound
 dec $0308,x
@sound:
 ; An active A pad also drives the pulse channel for audio replay checks.
 lda $0300,x
 and #1
 beq @next
 lda #1
 sta $4015
 lda #$bf
 sta $4000
 lda #$30
 sta $4002
 lda #8
 sta $4003
@next:
 inx
 cpx #4
 bne @move
 ; Same explicit engine world-publication boundary as GB/GBC, before view writes.
 inc $0600
 bne @worldPublished
 inc $0601
 bne @worldPublished
 inc $0602
 bne @worldPublished
 inc $0603
@worldPublished:
 lda #$a5
 sta $0604
 ldx #0
 ldy #0
@draw:
 lda rows,x
 sta $0200,y
 lda #1
 sta $0201,y
 txa
 sta $0202,y
 lda $0308,x
 sta $0203,y
 iny
 iny
 iny
 iny
 inx
 cpx #4
 bne @draw
 lda $9ff0
 sta $0310
 inc $030c
 jmp @tick
nmi:
 pha
 lda #0
 sta $2003
 lda #2
 sta $4014
 lda #0
 sta $2005
 sta $2005
 inc $00
 pla
 rti
irq: rti
canonical:
.byte 0,16,32,48,64,80,96,112,128,144,160,176,192,208,224,240,4,20,36,52,68,84,100,116,132,148,164,180,196,212,228,244,8,24,40,56,72,88,104,120,136,152,168,184,200,216,232,248,12,28,44,60,76,92,108,124,140,156,172,188,204,220,236,252,2,18,34,50,66,82,98,114,130,146,162,178,194,210,226,242,6,22,38,54,70,86,102,118,134,150,166,182,198,214,230,246,10,26,42,58,74,90,106,122,138,154,170,186,202,218,234,250,14,30,46,62,78,94,110,126,142,158,174,190,206,222,238,254,1,17,33,49,65,81,97,113,129,145,161,177,193,209,225,241,5,21,37,53,69,85,101,117,133,149,165,181,197,213,229,245,9,25,41,57,73,89,105,121,137,153,169,185,201,217,233,249,13,29,45,61,77,93,109,125,141,157,173,189,205,221,237,253,3,19,35,51,67,83,99,115,131,147,163,179,195,211,227,243,7,23,39,55,71,87,103,119,135,151,167,183,199,215,231,247,11,27,43,59,75,91,107,123,139,155,171,187,203,219,235,251,15,31,47,63,79,95,111,127,143,159,175,191,207,223,239,255
palette:
.byte $0f,$00,$00,$00,$0f,$00,$00,$00,$0f,$00,$00,$00,$0f,$00,$00,$00
.byte $0f,$2c,$3c,$1c,$0f,$28,$38,$18,$0f,$24,$34,$14,$0f,$2a,$3a,$1a
positions: .byte 48,80,112,144
rows: .byte 40,72,104,136
.segment "VECTORS"
.word nmi,reset,irq
.segment "CHARS"
.res 16,0
.byte $ff,$ff,$ff,$ff,$ff,$ff,$ff,$ff
.res 8,0
.res 8192-32,0
