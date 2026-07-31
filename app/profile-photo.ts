export const PROFILE_PHOTO_DIMENSION = 512;
export const PROFILE_PHOTO_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const PROFILE_PHOTO_MAX_UPLOAD_BYTES = 1_000_000;

export type SquareCrop = {
  sourceX: number;
  sourceY: number;
  sourceSize: number;
};

export function calculateSquareCrop(width: number, height: number): SquareCrop {
  const sourceSize = Math.min(width, height);
  return {
    sourceX: Math.max(0, (width - sourceSize) / 2),
    sourceY: Math.max(0, (height - sourceSize) / 2),
    sourceSize,
  };
}

export function validateProfilePhotoSelection(file: Pick<File, "size" | "type">) {
  if (!file.type.toLowerCase().startsWith("image/")) {
    throw new Error("Choose a JPEG, PNG, WebP, HEIC, or another image file.");
  }
  if (file.size <= 0 || file.size > PROFILE_PHOTO_MAX_SOURCE_BYTES) {
    throw new Error("Choose a photo smaller than 20 MB.");
  }
}

export async function prepareProfilePhoto(file: File): Promise<Blob> {
  validateProfilePhotoSelection(file);
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const crop = calculateSquareCrop(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = PROFILE_PHOTO_DIMENSION;
    canvas.height = PROFILE_PHOTO_DIMENSION;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not prepare the profile photo.");
    context.fillStyle = "#f3efe6";
    context.fillRect(0, 0, PROFILE_PHOTO_DIMENSION, PROFILE_PHOTO_DIMENSION);
    context.drawImage(
      image,
      crop.sourceX,
      crop.sourceY,
      crop.sourceSize,
      crop.sourceSize,
      0,
      0,
      PROFILE_PHOTO_DIMENSION,
      PROFILE_PHOTO_DIMENSION,
    );
    const blob = await canvasToJpeg(canvas);
    if (blob.size > PROFILE_PHOTO_MAX_UPLOAD_BYTES) {
      throw new Error("The processed photo is still too large. Choose another image.");
    }
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Signal could not read that photo. Choose another image."));
    image.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This browser could not prepare the profile photo."));
    }, "image/jpeg", 0.82);
  });
}
