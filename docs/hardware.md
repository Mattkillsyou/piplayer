# Hardware kit per projector

Everything one Projection5000 player needs, projector excluded. Prices are
approximate USD at the time of writing (list price, before tax and shipping);
check the linked page before ordering. Quantities are per projector unless the
section says otherwise. Links go to the maker's own store where it has one;
for the odd part that does not, search the part name at any electronics
retailer.

Camera setup (RTSP and Wyze) is in [camera.md](camera.md); the software side
of bringing a Pi up is in [adding-a-pi.md](adding-a-pi.md).

## Compute (Raspberry Pi 5)

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| Raspberry Pi 5, 4 GB | The player. 4 GB is plenty; 2 GB works but leaves no headroom for the Wyze bridge container. | 1 | $60 | [raspberrypi.com](https://www.raspberrypi.com/products/raspberry-pi-5/) |
| Raspberry Pi 27 W USB-C power supply | Official PSU. Anything weaker makes the Pi 5 throttle its USB ports (the IR blaster is USB-powered). | 1 | $12 | [raspberrypi.com](https://www.raspberrypi.com/products/27w-power-supply/) |
| Raspberry Pi 5 Case (with fan) | Official case, fan included. Alternative: Argon NEO 5 (passive aluminium, about $15). | 1 | $10 | [raspberrypi.com](https://www.raspberrypi.com/products/raspberry-pi-5-case/), [argon40.com](https://argon40.com/search?q=neo+5) |
| microSD 32 GB, high endurance | Boot + media. Use an endurance card (Samsung PRO Endurance or SanDisk MAX Endurance); consumer cards wear out in a year of 24/7 looping. | 1 | $11 | [samsung.com](https://www.samsung.com/us/computing/memory-storage/memory-cards/), [sandisk.com](https://www.sandisk.com/products/memory-cards) |
| micro-HDMI (D) to HDMI (A) cable, 2 m, 4K60 | Pi to projector. The official cable is fine; any cable rated HDMI 2.0 / 4K60 works. Plug into **HDMI0** (the port closer to USB-C). | 1 | $8 | [raspberrypi.com](https://www.raspberrypi.com/products/micro-hdmi-to-standard-hdmi-a-cable/) |

Subtotal: about $101.

## Control

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| Broadlink RM4 mini | IR blaster that turns the projector on and off. Powered from one of the Pi's USB ports; needs line of sight to the projector's IR receiver. 2.4 GHz Wi-Fi only. | 1 | $25 | [ibroadlink.com](https://www.ibroadlink.com/), [Amazon search](https://www.amazon.com/s?k=Broadlink+RM4+mini) |
| Wyze Plug | Smart plug on the projector's mains lead: hard power-cycle from your phone when IR is not enough. 2.4 GHz Wi-Fi only. Sold in 2-packs (about $20). | 1 | $14 | [wyze.com](https://www.wyze.com/products/wyze-plug) |

Subtotal: about $39.

## Camera (optional)

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| Wyze Cam v3 | Room camera whose snapshot shows on the console's device tile and Devices page. Comes with its own USB power supply. 2.4 GHz Wi-Fi only. | 1 | $36 | [wyze.com](https://www.wyze.com/products/wyze-cam-v3) |

Any camera with an RTSP stream works instead (see [camera.md](camera.md)).
The Wyze path needs the unofficial `mrlt8/wyze-bridge` container on the Pi
and a Wyze API key; the RTSP path needs nothing extra.

## Network

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| Cat6 patch cable, 3 m | Wired ethernet to the Pi. Wi-Fi works, but a wire is one less thing to debug remotely. | 1 | $7 | any retailer |
| Raspberry Pi PoE+ HAT for Pi 5 (optional) | Power and network over one cable from a PoE+ switch; replaces the USB-C PSU. **Pi 5 version only**; the Pi 4 PoE+ HAT does not fit the Pi 5 header. | 0-1 | $25 | [raspberrypi.com](https://www.raspberrypi.com/products/) |

Subtotal: about $7 (PoE+ HAT excluded).

## Audio (optional)

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| Powered speaker | Only if the projector has no usable speaker. Feed it over HDMI (projector audio out) or a USB audio dongle on the Pi. | 0-1 | $25-60 | any retailer |
| USB audio dongle | 3.5 mm out from the Pi 5 (which has no analogue jack). Skip if the projector or speaker takes HDMI audio. | 0-1 | $8 | any retailer |

Not included in the totals.

## Mounting and consumables

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| VESA / wall bracket for the Pi case, or heavy-duty Velcro | Fix the Pi near the projector, off the floor. | 1 | $8-15 | any retailer |
| Cable ties and adhesive cable clips | Dress the HDMI, power and IR cables so nobody trips or unplugs them. | 1 pack each | $8 | any retailer |
| Labels | Two per unit: the `device_id` on the Pi case and on the HDMI plug at the projector end. Label maker tape or a Sharpie on a sticker. | 2 | $2 | any retailer |
| Spare pre-flashed microSD | Same endurance card as above, flashed with the same device id (a re-flash enrolls the same device). Swap in on site if a card dies. | 1 | $11 | see Compute |

Subtotal: about $36.

## One-time (per fleet, not per projector)

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| USB microSD card reader | For the SD Flasher on the laptop. Get a USB 3 one; flashing and read-back verification are I/O bound. | 1 | $10 | any retailer |
| Spare Raspberry Pi 5 4 GB + 27 W PSU | Bench unit for testing, and a swap-in if a field unit dies. | 1 | $72 | [raspberrypi.com](https://www.raspberrypi.com/products/raspberry-pi-5/) |

## Pi 4 variant

Use this table instead of the Compute section when you have Pi 4s on hand.
Everything else in the kit is the same.

| Part | Purpose | Qty | Approx. USD | Link |
| --- | --- | --- | --- | --- |
| Raspberry Pi 4 Model B, 4 GB | 1080p output only (no 4K playback). H.264 decodes in software unless you enable `hwdec=v4l2m2m-copy` in mpv.conf (README, Operating notes). | 1 | $55 | [raspberrypi.com](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/) |
| Raspberry Pi 15 W USB-C power supply | Official Pi 4 PSU. | 1 | $8 | [raspberrypi.com](https://www.raspberrypi.com/products/type-c-power-supply/) |
| Flirc Raspberry Pi 4 case | Passive aluminium case (the whole case is the heatsink). No fan to fail. | 1 | $16 | [flirc.tv](https://flirc.tv/search?q=raspberry+pi+4) |
| micro-HDMI (D) to HDMI (A) cable | Same cable as the Pi 5 (both use micro-HDMI). | 1 | $8 | see Compute |
| microSD 32 GB, high endurance | Same card as the Pi 5. | 1 | $11 | see Compute |

Pi 4 compute subtotal: about $98 (roughly the same as the Pi 5; buy the
Pi 5 for new builds).

## Compatibility notes

- **Pi 5 Active Cooler and the official case lid are mutually exclusive.** The
  official Pi 5 Case ships with its own fan; do not also buy the Active Cooler
  for a cased Pi. Buy the Active Cooler only for a caseless or Argon NEO 5
  mount.
- **2.4 GHz Wi-Fi.** The Broadlink RM4 mini, the Wyze Plug and the Wyze Cam v3
  are all 2.4 GHz only. Your access point must broadcast a 2.4 GHz SSID (a
  5 GHz-only network, or a combined SSID that steers new clients to 5 GHz,
  will not pair). The Pi itself can be on ethernet or 5 GHz.
- **Raspberry Pi Camera Module 3 instead of a Wyze Cam.** If you want a Pi
  camera on the ribbon connector rather than a Wi-Fi camera, the Pi 5 needs
  the 22-pin to 15-pin camera cable (the Pi 5 uses the smaller 22-pin FPC
  connector; the cable in the Camera Module 3 box is the 15-pin Pi 4 one).
  You then need something on the Pi to serve it as RTSP (for example
  `mediamtx` with `rpicam-vid`); the player only reads RTSP. See
  [camera.md](camera.md).
- **micro-HDMI.** Pi 4 and Pi 5 both have two micro-HDMI (type D) ports. Use
  HDMI0, the one closer to the USB-C power port. A standard HDMI (type A)
  cable needs an adapter; buy the right cable instead.
- **USB power budget.** The RM4 mini draws under 1 W from a Pi USB port. If
  you also hang a USB audio dongle and a keyboard off the Pi 5, use the 27 W
  PSU (the 15 W Pi 4 PSU makes the Pi 5 limit USB to 600 mA total).
- **PoE+ HAT and the case.** The PoE+ HAT does not fit under the official
  Pi 5 Case lid. Run PoE units caseless with the Active Cooler, or in a HAT-
  friendly case.

## Cost per projector

| | Approx. USD |
| --- | --- |
| Compute (Pi 5) | $101 |
| Control (RM4 mini + Wyze Plug) | $39 |
| Network (Cat6) | $7 |
| Mounting and consumables (incl. spare microSD) | $36 |
| **Total without camera** | **about $185** |
| Wyze Cam v3 | $36 |
| **Total with Wyze Cam v3** | **about $220** |

Optional extras not in the totals: PoE+ HAT $25, audio $8-70. One-time per
fleet: card reader $10, spare Pi 5 + PSU $72.

## Unbox to playing

Per unit, in order. Steps 1-4 happen at the desk; 5-10 at the projector.

1. **Label.** Write the `device_id` (e.g. `lobby-projector`) on a label on
   the Pi case and another on the HDMI plug that will go into the projector.
2. **Flash the card.** On Windows run the Projection5000 SD Flasher
   (`tools/flasher/README.md`): fill in the device id, name, Wi-Fi (if not
   wired) and timezone, insert the card, click Flash. The exe carries the
   console URL and enrollment key, so no login is needed. Flash the spare
   card the same way with the same device id. (No Windows? Follow
   [adding-a-pi.md](adding-a-pi.md) with Raspberry Pi Imager instead.)
3. **Assemble.** Pi into the case (fan header connected), microSD in. If you
   use the PoE+ HAT, fit it now.
4. **Camera prep (Wyze only).** Set the camera up in the Wyze app on the
   2.4 GHz network and give it a short name (`Lobby cam`). Create a Wyze API
   key ([camera.md](camera.md), "Wyze API key"). Tell the flasher the
   camera name and the Wyze credentials under "Advanced" if your build has
   the camera fields; otherwise you set `[camera]` and `wyze.env` on the Pi
   after it enrolls.
5. **Cable at the projector.** HDMI cable from the Pi's HDMI0 to the
   projector. Ethernet if wired. Mount the Pi with the bracket or Velcro.
   Dress the cables with clips and ties.
6. **IR blaster.** Plug the RM4 mini into a Pi USB port and stand it with a
   clear line to the projector's IR receiver (front bezel on most models).
   Pair it in the Broadlink app on 2.4 GHz and learn the projector's power
   button.
7. **Smart plug.** Projector mains lead into the Wyze Plug, plug into the
   wall, pair in the Wyze app. Leave it on.
8. **Camera.** Plug the Wyze Cam in with its own PSU, aim it at the screen
   (or the room), confirm it streams in the Wyze app.
9. **Power up the Pi.** Insert the flashed card, connect the PSU. The Pi
   joins the network, enrolls and installs the player on first boot; the
   projector shows a black screen (mpv, no playlist) after 3-5 minutes.
10. **Console.** Open the console's **Devices** page. The device appears with
    its `device_id`, **Last seen** ticking and a screenshot within a minute.
    Assign a playlist (or a group); video starts on the next poll (30 s). If
    you set up a camera, the row also shows the room snapshot; paste the
    tunnel hostname into **Camera live URL** to enable **Live** (see
    [camera.md](camera.md), "Live view").
11. **Test the controls.** Projector off and on from the Broadlink app, then
    from the Wyze Plug. Confirm the Pi keeps running (it is on its own PSU,
    not the smart plug) and the picture comes back after the projector
    warms up.
12. **Pocket the spare card** in a labelled bag taped inside the projector
    mount, and write the date on it.
