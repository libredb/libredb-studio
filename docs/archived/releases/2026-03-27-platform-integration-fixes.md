# Session Summary: Platform Integration Fixes

**Date:** 2026-03-27
**Releases:** Studio v0.9.13, Platform v0.2.6
**npm:** @libredb/studio@0.9.13

## Problem

Studio standalone'da düzgün çalışırken, platform'a npm paketi olarak embed edildiğinde fontlar, ikonlar ve layout bozuluyordu. Günlerdir çözülemeyen bu sorunun birden fazla kök nedeni vardı.

## Keşfedilen Kök Nedenler

### 1. tailwind-merge custom token sorunu

`cn("text-body", "text-muted-foreground")` çağrısında `tailwind-merge`, custom `text-body` class'ını bir renk utility'si sanıp `text-muted-foreground` ile çakıştığını düşünüyor ve `text-body`'yi sessizce siliyordu. Sonuç: font-size hiç uygulanmıyor, browser default 16px'e düşüyordu.

Bu bug **görünmezdi** çünkü:
- Studio standalone → Tailwind `text-body` için CSS üretiyordu, ama `cn()` JSX çıktısında class'ı siliyordu
- Bazı yerlerde `cn()` kullanılmadan doğrudan `className="text-body"` yazıldığında çalışıyordu
- Chrome DevTools'ta rendered HTML incelendiğinde `text-body` class'ının olmadığı fark edildi

**Çözüm:** Custom `@theme` text token'ları (`text-body`, `text-data`, `text-label`, vb.) tamamen kaldırıldı. Standart Tailwind class'ları (`text-xs`, `text-sm`) ve arbitrary value'lar (`text-[0.625rem]`) kullanıldı. İkisini de `tailwind-merge` native olarak tanır.

### 2. @source chunk tarama eksikliği

`tsup` (build:lib) studio dist'ini `workspace.mjs` + `chunk-*.mjs` dosyalarına bölüyor. Platform'un `globals.css`'indeki `@source` direktifi sadece `workspace.mjs`'i tarıyordu. ResultsGrid, ConnectionModal gibi büyük bileşenler chunk dosyalarına düşüyordu ve oradaki responsive class'lar (`md:hidden`, `sm:block`, `md:grid-cols-4`) platform'un Tailwind'i tarafından CSS'e dönüştürülmüyordu.

**Sonuç:** Mobil ve desktop view'lar aynı anda render ediliyordu (ResultsGrid hem card hem table gösteriyordu).

**Çözüm:** Platform'un `globals.css`'ine `@source "../../node_modules/@libredb/studio/dist/chunk-*.mjs"` eklendi.

### 3. Lucide ikon tutarsızlığı

Lucide React ikonları default olarak:
- `strokeWidth=2` (kalın çizgi)
- `width="24" height="24"` HTML attribute'ları (CSS override'ı zorlaştırabilir)

Custom DB ikonları (`getDBIcon`) ise:
- `strokeWidth=1.5` (ince çizgi)
- HTML width/height attribute'sız (tamamen CSS'e bağımlı)

**Çözüm:** Tüm Lucide ikon kullanımlarına `strokeWidth={1.5}` prop'u eklendi. Bu Lucide'ın resmi API'si.

### 4. shadcn Button CSS specificity

Studio sidebar/explorer'daki küçük ikon butonları `<Button size="icon" className="w-6 h-6">` kullanıyordu. Platform'a embed edildiğinde, platform'un shadcn Button CSS'i (`size-9` default) studio'nun `w-6 h-6` override'ını eziyordu.

**Çözüm:** Sidebar ve schema-explorer'daki küçük ikon butonları plain `<button className="p-1 rounded ...">` ile değiştirildi.

## Yapılan Değişiklikler

### Studio (v0.9.13)

| Kategori | Değişiklik |
|---|---|
| **Font sistemi** | Custom `@theme` text token'ları kaldırıldı, standart Tailwind + arbitrary value'lara geçildi |
| **Font ağırlıkları** | `font-bold` → `font-medium` tüm bileşenlerde (admin/ui hariç) |
| **Uppercase** | 126 kullanım kaldırıldı, sadece 10 teknik kısaltma kaldı (font-mono column types, PK/Null/Unq badge) |
| **İkonlar** | Tüm Lucide ikonlara `strokeWidth={1.5}` eklendi |
| **İkon boyutları** | `w-3.5 h-3.5` (section), `w-3 h-3` (toolbar/tab), `w-2.5 h-2.5` (detail) |
| **Butonlar** | shadcn `Button size="icon"` → plain `<button>` (sidebar/explorer) |
| **CI** | `integration-check.yml` — custom token, Button, strokeWidth kontrolleri |
| **Dokümantasyon** | CLAUDE.md'ye platform integration kuralları, do/don't tablosu, verification workflow |

### Platform (v0.2.6)

| Kategori | Değişiklik |
|---|---|
| **@source** | `chunk-*.mjs` taraması eklendi |
| **CI** | `studio-integration-check.yml` — @source direktif ve custom token kontrolleri |
| **Bağımlılık** | `@libredb/studio` ^0.9.13'e güncellendi |

## CI Güvenceleri

### Studio: `integration-check.yml`
- Custom `@theme` text token yasağı (error)
- Custom `text-*` class kullanım yasağı (error)
- shadcn `Button size="icon"` yasağı — sidebar/explorer (error)
- Dist chunk responsive class analizi (notice)

### Platform: `studio-integration-check.yml`
- `@source workspace.mjs` kontrolü (error)
- `@source chunk-*.mjs` kontrolü (error)
- Custom studio text token yasağı (error)

## Öğrenilen Dersler

1. **npm paketi olarak tüketilen bileşenlerde custom Tailwind token kullanma** — `tailwind-merge` tanımadığı token'ları sessizce siler
2. **tsup chunk yapısını hesaba kat** — `@source` direktifi tüm chunk'ları taramalı
3. **Lucide ikonların HTML attribute'ları var** — `strokeWidth` ve boyut prop'larını explicit ver
4. **shadcn component'ları embed edildiğinde CSS specificity sorunları yaratabilir** — basit case'lerde plain HTML element kullan
5. **Chrome DevTools rendered HTML analizi** — class'ların gerçekten uygulanıp uygulanmadığını kaynak kodu yerine rendered HTML'de kontrol et
