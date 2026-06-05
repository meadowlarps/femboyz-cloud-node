// shared logic for fetching uploads

// (project root)/schema/frontend_upload_receiveByID
type UploadData = {
    id: string,
    type: string,
    public: boolean,
    meta: { title: string, desc: string },
    files: _FileData[],
    when: string
}

type _FileData = {
    index: number,
    filename: string,
    size: number,
    mime: string,
    url: string,
}

