import { NewArtist } from "@/components/NewArtist";

export default function NewArtistPage() {
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Nieuwe artiest</h1>
      <NewArtist />
    </div>
  );
}
