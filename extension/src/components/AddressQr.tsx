import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code of any text. It shows nothing if it cannot draw. */
export function TextQr({ text, alt }: { text: string; alt: string }) {
  const [image, setImage] = useState<{ text: string; url: string } | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { width: 360, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => {
        if (live) setImage({ text, url });
      })
      .catch(() => {
        if (live) setImage(null);
      });
    return () => {
      live = false;
    };
  }, [text]);

  return (
    <div className="mx-auto size-44 rounded-2xl bg-white p-2 ring-1 ring-line">
      {image?.text === text && <img src={image.url} alt={alt} className="size-full" />}
    </div>
  );
}

/** A QR code of the wallet address, so another wallet can scan it. */
export function AddressQr({ address }: { address: string }) {
  return <TextQr text={address} alt={`QR code of the address ${address}`} />;
}
