# S3 image upload requests

This folder stores request manifests used by the maintainer-only workflow:

- Workflow: `.github/workflows/s3-image-upload.yml`
- Script: `.github/scripts/upload-s3-images.mjs`

## Request format

Each request file must be JSON and follow this schema:

```json
{
  "assets": [
    {
      "source_url": "https://raw.githubusercontent.com/github/explore/main/topics/actions/actions.png",
      "target_path": "images/contribute/examples",
      "name": "security-example"
    }
  ]
}
```

- `source_url`: HTTPS URL to a temporary/publicly accessible image.
- `target_path`: Must start with `images/` (for example: `images/safe-harbor`).
- `name` (optional): basename override for the uploaded file.

The workflow appends a content hash to each filename to create a unique object key and prevent accidental overwrites.
