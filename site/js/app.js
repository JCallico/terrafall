/* ==========================================================================
   Terrafall — application logic
   Detects the visitor's location (browser GPS/Wi-Fi first, IP geolocation
   as fallback), then animates a satellite map from orbit down to that spot.
   ========================================================================== */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    loader: $('loader'),
    statusText: $('statusText'),
    loaderFill: $('loaderFill'),
    crosshair: $('crosshair'),
    methodChip: $('methodChip'),
    methodText: $('methodText'),
    zoomValue: $('zoomValue'),
    coordsLine: $('coordsLine'),
    altLine: $('altLine'),
    replayBtn: $('replayBtn'),
    recenterBtn: $('recenterBtn'),
    northBtn: $('northBtn'),
  };

  // Tunables
  const START_ZOOM = 1.6;        // whole-Earth orbit
  const FLIGHT_ZOOM = 20;        // closest practical detail level (precise fix only)
  const AREA_ZOOM = 11;          // city/region level when only an approximate fix is known
  const FLIGHT_DURATION = 14000; // descent length (ms)
  const OVERZOOM_MAX = 22;       // allow over-zoom past source maxzoom
  const PRECISE_ACCURACY_M = 500; // GPS accuracy (m) below which a street-level pin is trusted

  // IP geolocation providers (no API key required). Ordered by reliability.
  const IP_PROVIDERS = [
    { url: 'https://ipwho.is/', parse: (d) => ({ lat: d.latitude, lng: d.longitude, city: d.city, region: d.region, country: d.country }) },
    { url: 'https://ipapi.co/json/', parse: (d) => ({ lat: d.latitude, lng: d.longitude, city: d.city, region: d.region, country: d.country_name }) },
  ];

  let map = null;
  let marker = null;
  let target = null;   // { lat, lng, accuracy, method, city, region, country }
  let arrived = false;
  let flying = false;

  /* A "precise" fix is GPS/Wi-Fi with tight accuracy. Anything else (IP
     geolocation, or GPS with a large error radius) is only an approximate
     area and must not be presented as a street-level address. */
  function isPrecise(t) {
    return t.method === 'gps' && t.accuracy != null && t.accuracy <= PRECISE_ACCURACY_M;
  }

  function targetZoom(t) {
    return isPrecise(t) ? FLIGHT_ZOOM : AREA_ZOOM;
  }

  /* ------------------------------------------------------------------------
     Status / loader
     ------------------------------------------------------------------------ */
  function setStatus(text, progress) {
    els.statusText.textContent = text;
    if (progress != null) els.loaderFill.style.width = Math.round(progress) + '%';
  }

  /* ------------------------------------------------------------------------
     Map setup
     ------------------------------------------------------------------------ */
  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          satellite: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            maxzoom: 19,
            attribution:
              'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
          },
        },
        layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
      },
      center: [0, 15],
      zoom: START_ZOOM,
      minZoom: 1,
      maxZoom: OVERZOOM_MAX,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    // Reveal the "reset north" control when the camera is tilted/rotated.
    map.on('rotate', updateNorthButton);
    map.on('pitch', updateNorthButton);
  }

  function updateNorthButton() {
    if (!map) return;
    const rotated = Math.abs(map.getBearing()) > 1 || map.getPitch() > 1;
    els.northBtn.classList.toggle('hidden', !rotated);
  }

  /* ------------------------------------------------------------------------
     Location detection
     ------------------------------------------------------------------------ */
  async function locate() {
    setStatus('Contacting the satellite…', 12);
    await wait(500);

    setStatus('Triangulating your position…', 38);
    const gps = await browserGeolocation();

    if (gps) {
      target = gps;
      setStatus(isPrecise(gps) ? 'Position locked.' : 'Approximate position found.', 100);
      return begin();
    }

    setStatus('GPS unavailable — locating by IP address…', 62);
    const ip = await ipGeolocation();

    if (ip) {
      target = ip;
      setStatus('Located to city level.', 100);
      return begin();
    }

    setStatus('Could not determine your location.', 100);
    revealWorld();
  }

  function browserGeolocation() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            method: 'gps',
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 }
      );
    });
  }

  async function ipGeolocation() {
    for (const provider of IP_PROVIDERS) {
      try {
        const res = await fetch(provider.url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const data = await res.json();
        const parsed = provider.parse(data);
        if (parsed.lat == null || parsed.lng == null) continue;
        return { ...parsed, accuracy: null, method: 'ip' };
      } catch (_) {
        /* try next provider */
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------------
     The descent
     ------------------------------------------------------------------------ */
  function begin() {
    setStatus('Beginning the descent…', 100);
    els.methodChip.classList.add(isPrecise(target) ? 'locked' : 'approximate');

    // Let the "locked" beat land before the camera moves.
    setTimeout(() => {
      els.loader.classList.add('done');
      document.body.classList.add('descending');
      descend();
    }, 700);
  }

  function descend() {
    if (!target || !map) return;
    flying = true;

    placeMarker();

    map.once('moveend', onArrival);
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: targetZoom(target),
      pitch: 0,
      bearing: 0,
      duration: FLIGHT_DURATION,
      essential: true,
      curve: 1.55,
    });

    updateFlightReadout();
  }

  function onArrival() {
    flying = false;
    arrived = true;
    document.body.classList.remove('descending');
    document.body.classList.add('arrived');
    els.crosshair.classList.add('fade');

    setMethodText(target);
    els.coordsLine.textContent = coordsLabel(target);
    els.altLine.textContent = 'altitude ' + formatAltitude(altitudeFromZoom(map.getZoom()));
    updateZoomValue();
  }

  /* Live zoom / altitude readout while descending */
  function updateFlightReadout() {
    const tick = () => {
      if (!flying) return;
      updateZoomValue();
      els.altLine.textContent = 'altitude ' + formatAltitude(altitudeFromZoom(map.getZoom()));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function updateZoomValue() {
    els.zoomValue.textContent = map.getZoom().toFixed(2);
  }

  /* ------------------------------------------------------------------------
     Marker
     ------------------------------------------------------------------------ */
  function placeMarker() {
    if (marker) marker.remove();
    const el = document.createElement('div');

    if (isPrecise(target)) {
      el.className = 'marker';
      el.innerHTML = '<div class="marker-ping"></div><div class="marker-dot"></div>';
    } else {
      // Approximate fix: a soft area ring, not a street-level pin.
      el.className = 'area-marker';
      el.innerHTML = '<div class="area-marker-ring"></div><span class="area-marker-label">approx.</span>';
    }

    marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([target.lng, target.lat])
      .addTo(map);
  }

  /* ------------------------------------------------------------------------
     Controls
     ------------------------------------------------------------------------ */
  function replay() {
    if (flying || !target) return;
    arrived = false;
    flying = true;

    document.body.classList.remove('arrived');
    document.body.classList.add('descending');
    els.crosshair.classList.remove('fade');
    els.coordsLine.textContent = '—';
    if (marker) { marker.remove(); marker = null; }

    map.flyTo({
      center: [0, 15],
      zoom: START_ZOOM,
      pitch: 0,
      bearing: 0,
      duration: 3000,
      essential: true,
    });

    map.once('moveend', () => {
      placeMarker();
      map.once('moveend', onArrival);
      updateFlightReadout();
      map.flyTo({
        center: [target.lng, target.lat],
        zoom: targetZoom(target),
        pitch: 0,
        bearing: 0,
        duration: FLIGHT_DURATION,
        essential: true,
        curve: 1.55,
      });
    });
  }

  function recenter() {
    if (!target || !map || flying) return;
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: Math.max(map.getZoom(), targetZoom(target)),
      duration: 2200,
      essential: true,
    });
  }

  function resetNorth() {
    if (!map) return;
    map.easeTo({ bearing: 0, pitch: 0, duration: 800 });
  }

  /* ------------------------------------------------------------------------
     Fallback: reveal the world without a fix
     ------------------------------------------------------------------------ */
  function revealWorld() {
    els.methodChip.classList.add('approximate');
    els.methodText.textContent = 'no fix';
    setTimeout(() => {
      els.loader.classList.add('done');
      document.body.classList.add('arrived');
      els.crosshair.classList.add('fade');
      els.coordsLine.textContent = 'Location unavailable';
      els.altLine.textContent = 'explore freely below';
    }, 700);
  }

  /* ------------------------------------------------------------------------
     Formatting helpers
     ------------------------------------------------------------------------ */
  function setMethodText(t) {
    if (isPrecise(t)) {
      els.methodText.textContent = `GPS · ± ${Math.round(t.accuracy)} m`;
    } else if (t.method === 'gps') {
      els.methodText.textContent = `GPS · ± ${Math.round(t.accuracy)} m · approximate`;
    } else {
      const place = [t.city, t.country].filter(Boolean).join(', ');
      els.methodText.textContent = place ? `IP · ${place} · approximate` : 'IP · approximate';
    }
  }

  function formatLatLng(lat, lng) {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(5)}° ${ns}   ${Math.abs(lng).toFixed(5)}° ${ew}`;
  }

  // A label that never overstates what we know: precise fixes get exact
  // coordinates; approximate fixes get the area name (or coarse coordinates)
  // instead of a fake street-level address.
  function coordsLabel(t) {
    if (isPrecise(t)) return formatLatLng(t.lat, t.lng);
    const place = [t.city, t.region, t.country].filter(Boolean).join(', ');
    if (place) return `≈ ${place}`;
    return `≈ ${formatLatLngRough(t.lat, t.lng)}`;
  }

  function formatLatLngRough(lat, lng) {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(1)}° ${ns}   ${Math.abs(lng).toFixed(1)}° ${ew}`;
  }

  // Rough camera altitude in meters derived from zoom level.
  function altitudeFromZoom(z) {
    return 20000000 * Math.pow(2, -z);
  }

  function formatAltitude(m) {
    if (m >= 1000) {
      return (m / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' km';
    }
    return Math.round(m).toLocaleString() + ' m';
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */
  function boot() {
    initMap();
    els.replayBtn.addEventListener('click', replay);
    els.recenterBtn.addEventListener('click', recenter);
    els.northBtn.addEventListener('click', resetNorth);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'r' || e.key === 'R') replay();
      if (e.key === 'n' || e.key === 'N') resetNorth();
    });

    map.once('load', locate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
