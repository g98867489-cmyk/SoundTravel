SOUNDTRAVEL  v2
===============
Sound ke through file transfer. Bina internet, bina Bluetooth, bina server.


v2 ME KYA TEGA HUA
------------------
  1. TURBO mode        — 2.67 ms symbols (pehle sabse tez 5.33 ms tha)
  2. Bade frames       — 128 bytes payload (pehle 32) => overhead 18% -> 5%
  3. GZIP compression  — text / code / JSON / HTML 3-5x chhota ho jata hai
  4. Photo quality     — 900px / 1400px / full, aap chuno
  5. Naya timing loop  — clock drift ko track karta hai (rate estimate)
  6. Receiver chaaro mode ek saath try karta hai — kuch set karne ki zaroorat nahi

Pehle ke muqable: turbo ~4.6x tez, aur gzip ke saath text ~10-20x tez.


SPEED (net bytes/sec)
---------------------
  Turbo      178 B/s    10 KB ~ 1 min     100 KB ~ 10 min
  Fast        89 B/s    10 KB ~ 2 min     100 KB ~ 19 min
  Balanced    44 B/s    10 KB ~ 4 min     100 KB ~ 38 min
  Safe        22 B/s    10 KB ~ 8 min     100 KB ~ 77 min

  Text / link / code  -> gzip lagta hai, to 3-5x aur tez
  Photo (900px)       -> 15-30 sec
  50 KB PDF           -> 5-10 min (turbo)
  100 KB+ PDF         -> 10-40 min
  Video               -> practical nahi. Pehle chhota karo.

Turbo sabse tez hai par purane / saste speaker pe fail ho sakta hai.
Fail ho to receiver kuch nahi pakdega — bas Fast ya Balanced pe aa jao.


CHALANE KA TARIKA
-----------------
Dono devices pe app kholo (ek Send, doosra Receive).

  1. Send: file chuno (ya Text tab me link likho)
  2. Speed: Turbo (default) — na chale to Fast
  3. Volume 100%
  4. "Start transmitting"
  5. Doosre pe "Start listening", mic allow karo
  6. Phone aamne-saamne 10-20 cm

Local test:
    python3 -m http.server 8000
    http://localhost:8000


KAAM NA KARE TO
---------------
  Kuch bhi receive nahi ho raha -> Turbo se Fast pe jao, volume badhao
  Progress ruk gaya             -> kuch mat karo, sender loop me bhej raha
                                   hai, apne aap bhar jayega
  Bahut slow                    -> photo quality "Chhota" karo, ya Turbo
  Sab fail                      -> "Safe" mode, silent mode off, phone paas


ANDAR KYA HAI
-------------
  Modulation : 16-tone FSK, 4 bits per symbol
  Symbols    : safe 21.3ms / balanced 10.7ms / fast 5.3ms / turbo 2.7ms
  Frame      : 4-symbol sync + seq(2) + len(1) + 128B payload + CRC16
  Timing     : per-symbol error naap ke position theek hoti hai, aur
               rate (clock drift) ko alag se estimate kiya jata hai
  Recovery   : CRC fail = frame drop; sender loop karta hai, to agle
               round me mil jata hai. Kuch dobara nahi karna padta.
  Compression: gzip (browser ka CompressionStream)

Sab kuch browser me. Koi data upload nahi hota.


PUBLISH
-------
HTTPS zaroori (mic ke liye).
  https://app.netlify.com/drop   <- folder drag karo
  https://vercel.com/new
  GitHub Pages: Settings -> Pages -> main / root

Files ROOT me honi chahiye (index.html + sw.js ek hi folder me).

Update karne par sw.js me CACHE_VERSION badal do.
