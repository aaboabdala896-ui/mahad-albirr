export function normalizePhone(rawPhone) {
  if (rawPhone === null || rawPhone === undefined) return "";

  const digits = String(rawPhone).replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("966")) return digits;
  if (digits.startsWith("0")) return `966${digits.slice(1)}`;

  return digits;
}

export async function findParentByPhone(supabase, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;

  const normalized = phone.replace(/^966/, "0");
  const { data, error } = await supabase
    .from("parents")
    .select("*")
    .or(`phone.eq.${phone},phone.eq.${normalized}`)
    .limit(1);

  if (error) throw error;
  return (data && data[0]) || null;
}

export async function createStudentWithParent({
  supabase,
  student,
  teacherId,
  parentPhone,
  parentName,
  username,
  password,
  existingParentId,
}) {
  const phone = normalizePhone(parentPhone);
  let parentId = existingParentId ?? null;

  if (!parentId) {
    const { data: userRow, error: userError } = await supabase
      .from("users")
      .insert({
        username,
        password,
        role: "parent",
        name: parentName,
      })
      .select()
      .single();

    if (userError) throw userError;

    const { error: parentError } = await supabase.from("parents").insert({
      id: userRow.id,
      name: parentName,
      phone,
    });

    if (parentError) throw parentError;
    parentId = userRow.id;
  }

  const { data: studentRow, error: studentError } = await supabase
    .from("students")
    .insert({
      name: student.name,
      age: Number(student.age) || 0,
      gender: student.gender || "male",
      level: student.level || "",
      next_lesson: student.nextLesson || "",
      behavior: student.behavior ?? 70,
      notes: student.notes || "",
      teacher_id: teacherId || null,
      parent_id: parentId,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (studentError) throw studentError;

  return {
    student: studentRow,
    parentId,
    createdParent: !existingParentId,
  };
}

export async function attachExistingParentToStudent({
  supabase,
  student,
  teacherId,
  parentId,
}) {
  const { data: studentRow, error: studentError } = await supabase
    .from("students")
    .insert({
      name: student.name,
      age: Number(student.age) || 0,
      gender: student.gender || "male",
      level: student.level || "",
      next_lesson: student.nextLesson || "",
      behavior: student.behavior ?? 70,
      notes: student.notes || "",
      teacher_id: teacherId || null,
      parent_id: parentId,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (studentError) throw studentError;
  return { student: studentRow, parentId };
}
