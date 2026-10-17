import { FileUploadPage } from "@/components/FileUpload";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "File upload · DataDesk" };

export default async function FileUpload() {
  const user = await requireUser("/file-upload");
  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 lg:px-6">
      <div className="py-4">
        <h1 className="text-2xl">File upload</h1>
        <p className="mt-1 text-sm text-muted">
          Send a CSV or Excel file to a BigQuery table through Cloud Run: checked here first, approved by an admin, then
          loaded by the file processor, with every step shown on the request.
        </p>
      </div>
      <FileUploadPage isAdmin={user.role === "admin"} />
    </div>
  );
}
