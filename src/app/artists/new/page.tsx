import { ArtistForm } from "@/components/ArtistForm";

export default function NewArtistPage() {
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Nieuwe artiest</h1>
      <ArtistForm />
    </div>
  );
}
